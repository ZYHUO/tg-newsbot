import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { XMLParser } from 'fast-xml-parser'
import { config } from './config.js'

const execFileP = promisify(execFile)

const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0'

export interface RawItem {
  url: string
  title: string
  publishedAt: number | null
  /** short plain-text excerpt of the entry body, for the summarizer */
  excerpt: string
  /** first usable image URL from the entry, '' if none */
  imageUrl: string
}

/**
 * Fetch a URL with curl. curl handles SOCKS proxies, redirects and the
 * assorted TLS weirdness of news sites far more reliably than node fetch
 * on this network, and feed volume is low enough that spawning is free.
 */
export async function fetchUrl(url: string, opts: { proxy?: boolean } = {}): Promise<string> {
  const args = [
    '-sSL',
    '--max-time', String(config.fetchTimeoutSec),
    '--compressed',
    '-A', UA,
    ...(opts.proxy ? ['-x', config.proxy] : []),
    url,
  ]
  const { stdout } = await execFileP('curl', args, { maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // entity-heavy feeds (e.g. simonwillison.net) trip the expansion guard;
  // we decode the common entities ourselves in stripHtml instead
  processEntities: false,
  // never coerce <guid>123456</guid> / <title>2024</title> into JS numbers
  parseTagValue: false,
  parseAttributeValue: false,
})

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return []
  return Array.isArray(v) ? v : [v]
}

function text(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number') return String(v)
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    // fast-xml-parser puts node text under #text when attributes exist
    if (typeof o['#text'] === 'string' || typeof o['#text'] === 'number') return String(o['#text']).trim()
    // atom <link href="..."/>
    if (typeof o['@_href'] === 'string') return o['@_href'].trim()
  }
  return ''
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', mdash: '—', ndash: '–', hellip: '…',
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
}

function stripHtml(s: string): string {
  // decode twice: feeds often double-escape HTML inside XML (&amp;lt;p&amp;gt;)
  return decodeEntities(decodeEntities(s))
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseDate(s: string): number | null {
  if (!s) return null
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : t
}

/** normalize a candidate image URL; '' if unusable. */
function cleanImageUrl(raw: string): string {
  // attribute URLs keep entities (processEntities:false), e.g. ?a=1&#038;b=2
  let u = decodeEntities(decodeEntities(raw)).trim()
  if (!u) return ''
  if (u.startsWith('//')) u = 'https:' + u
  if (!/^https?:\/\//i.test(u)) return '' // drop relative/data: URLs
  // skip tracking pixels and animated/junk formats Telegram renders poorly
  if (/(feedburner|doubleclick|googlesyndication|google-analytics|\/pixel|\/track|\/beacon|1x1|spacer)/i.test(u)) return ''
  if (/\.(gif|svg)(\?|#|$)/i.test(u)) return ''
  return u
}

function imgFromBody(body: string): string {
  // body may be escaped HTML (processEntities:false) or real HTML (CDATA)
  const html = decodeEntities(decodeEntities(body))
  const m = html.match(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/i)
  return m ? cleanImageUrl(m[1]) : ''
}

/** Extract the best image URL from a feed entry node. */
function pickImage(node: Record<string, unknown>): string {
  // <enclosure url type="image/..."/>
  for (const enc of asArray(node.enclosure as unknown)) {
    if (enc && typeof enc === 'object') {
      const o = enc as Record<string, string>
      const type = (o['@_type'] ?? '').toLowerCase()
      const u = o['@_url'] ?? ''
      if (u && (type.startsWith('image/') || /\.(jpe?g|png|webp)(\?|#|$)/i.test(u))) {
        const c = cleanImageUrl(u)
        if (c) return c
      }
    }
  }
  // <media:content medium="image"/> and <media:thumbnail/> (incl. inside <media:group>)
  const mediaHosts = [node, node['media:group']].filter(Boolean) as Record<string, unknown>[]
  for (const host of mediaHosts) {
    for (const field of ['media:content', 'media:thumbnail']) {
      for (const m of asArray(host[field] as unknown)) {
        if (m && typeof m === 'object') {
          const o = m as Record<string, string>
          const medium = (o['@_medium'] ?? '').toLowerCase()
          const type = (o['@_type'] ?? '').toLowerCase()
          const u = o['@_url'] ?? ''
          if (u && (field === 'media:thumbnail' || medium === 'image' || type.startsWith('image/') ||
            /\.(jpe?g|png|webp)(\?|#|$)/i.test(u))) {
            const c = cleanImageUrl(u)
            if (c) return c
          }
        }
      }
    }
  }
  // first <img> inside any body field
  for (const field of ['content:encoded', 'description', 'summary', 'content']) {
    const c = imgFromBody(text(node[field]))
    if (c) return c
  }
  return ''
}

function atomLink(entry: Record<string, unknown>): string {
  const links = asArray(entry.link as unknown)
  // prefer rel="alternate" (or no rel), skip rel="self"/"edit"
  for (const l of links) {
    if (typeof l === 'object' && l !== null) {
      const o = l as Record<string, unknown>
      const rel = o['@_rel']
      if (rel === undefined || rel === 'alternate') return text(l)
    }
  }
  return text(links[0])
}

/** Parse RSS 2.0 / Atom / RDF (RSS 1.0) into a flat item list. */
export function parseFeed(xml: string): RawItem[] {
  const doc = parser.parse(xml)
  const items: RawItem[] = []

  const push = (node: Record<string, unknown>, url: string, title: string, date: string, body: string) => {
    url = url.trim()
    title = stripHtml(title)
    if (!url || !title) return
    items.push({
      url,
      title,
      publishedAt: parseDate(date),
      excerpt: stripHtml(body).slice(0, 800),
      imageUrl: pickImage(node),
    })
  }

  if (doc.rss?.channel) {
    for (const it of asArray(doc.rss.channel.item)) {
      push(
        it,
        text(it.link) || text(it.guid),
        text(it.title),
        text(it.pubDate) || text(it['dc:date']),
        text(it.description) || text(it['content:encoded']),
      )
    }
  } else if (doc.feed) {
    for (const it of asArray(doc.feed.entry)) {
      push(
        it,
        atomLink(it),
        text(it.title),
        text(it.published) || text(it.updated),
        text(it.summary) || text(it.content),
      )
    }
  } else if (doc['rdf:RDF']) {
    for (const it of asArray(doc['rdf:RDF'].item)) {
      push(
        it,
        text(it.link),
        text(it.title),
        text(it['dc:date']) || text(it.pubDate),
        text(it.description),
      )
    }
  }
  return items
}

export async function fetchFeed(url: string, needsProxy: boolean): Promise<RawItem[]> {
  let xml: string
  try {
    xml = await fetchUrl(url, { proxy: needsProxy })
  } catch (err) {
    // direct-configured feeds occasionally get reset; retry once via proxy
    if (!needsProxy) {
      xml = await fetchUrl(url, { proxy: true })
    } else {
      throw err
    }
  }
  const items = parseFeed(xml)
  if (items.length === 0 && !/<(rss|feed|rdf)/i.test(xml.slice(0, 2000))) {
    throw new Error(`not a feed (got ${xml.slice(0, 120).replace(/\s+/g, ' ')}…)`)
  }
  return items
}
