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
export async function fetchUrl(url: string, opts: { proxy?: boolean; timeoutSec?: number } = {}): Promise<string> {
  const args = [
    '-sSL',
    '--max-time', String(opts.timeoutSec ?? config.fetchTimeoutSec),
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

/** String.fromCodePoint throws RangeError on cp > 0x10FFFF — never let a
 *  malformed entity in one item crash the parse of the whole feed. */
function safeFromCodePoint(cp: number, original: string): string {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return original
  try {
    return String.fromCodePoint(cp)
  } catch {
    return original
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => safeFromCodePoint(parseInt(h, 16), m))
    .replace(/&#(\d+);/g, (m, d) => safeFromCodePoint(Number(d), m))
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
  // tracking ad/analytics hosts
  if (/(feedburner|doubleclick|googlesyndication|google-analytics)/i.test(u)) return ''
  // pixel/track/beacon/spacer as a WHOLE path segment or filename stem only, so
  // legit names survive ("track-and-field.jpg", "spacerville-news.jpg")
  if (/\/(pixel|beacon|spacer|track|tracking)(\/|\.|$)/i.test(u)) return ''
  if (/[/_.-]1x1([/_.-]|$)/i.test(u)) return ''
  // generic site logo/placeholder og:images (repeat on every article) — match
  // only when it's the WHOLE filename, so "company-logo-news.jpg" survives
  if (/\/(logo\d*|default|placeholder|share|og-?image|og-?default)\.(jpe?g|png|webp|gif)(\?|#|$)/i.test(u)) return ''
  if (/\.(gif|svg)(\?|#|$)/i.test(u)) return ''
  return u
}

/** non-image file extensions that should never be sent as a photo */
const NON_IMAGE_EXT = /\.(html?|php|aspx?|jsp|xml|json|mp4|webm|m3u8|mp3|pdf|zip)(\?|#|$)/i
const IMAGE_EXT = /\.(jpe?g|png|webp)(\?|#|$)/i

function imgFromBody(body: string): string {
  // body may be escaped HTML (processEntities:false) or real HTML (CDATA)
  const html = decodeEntities(decodeEntities(body))
  // try real lazy-load attributes BEFORE plain src (which is often a
  // data:/placeholder), then a plain src that isn't itself a data-* attr
  for (const re of [
    /<img\b[^>]*?\bdata-(?:src|original|lazy-src|lazy)\s*=\s*["']([^"']+)["']/i,
    /<img\b[^>]*?(?<![-\w])src\s*=\s*["']([^"']+)["']/i,
  ]) {
    const m = html.match(re)
    if (m) {
      const c = cleanImageUrl(m[1])
      if (c) return c
    }
  }
  return ''
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
  // <media:content medium="image"/> and <media:thumbnail/> (incl. inside one
  // or more <media:group> wrappers — fast-xml-parser yields an array if >1)
  const groups = asArray(node['media:group'] as unknown).filter(g => g && typeof g === 'object')
  const mediaHosts = [node, ...groups] as Record<string, unknown>[]
  for (const host of mediaHosts) {
    for (const field of ['media:content', 'media:thumbnail']) {
      for (const m of asArray(host[field] as unknown)) {
        if (m && typeof m === 'object') {
          const o = m as Record<string, string>
          const medium = (o['@_medium'] ?? '').toLowerCase()
          const type = (o['@_type'] ?? '').toLowerCase()
          const u = o['@_url'] ?? ''
          // explicit image signal, or (for type-less thumbnails) at least not a
          // known non-image URL — never hand sendPhoto an .html/.mp4 thumbnail
          const imageish = medium === 'image' || type.startsWith('image/') || IMAGE_EXT.test(u)
          const okThumb = field === 'media:thumbnail' && !NON_IMAGE_EXT.test(u)
          if (u && (imageish || okThumb)) {
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

/**
 * Best-effort cover image: fetch the article page and read its og:image
 * (or twitter:image) meta tag. Used when the feed entry carried no image.
 * Never throws — returns '' on any failure. Single attempt with the feed's
 * known proxy setting + a short timeout (it's best-effort; no direct↔proxy
 * fallback that would double the wait inside the serialized publish loop).
 */
export async function fetchOgImage(pageUrl: string, needsProxy = false): Promise<string> {
  let html: string
  try {
    html = await fetchUrl(pageUrl, { proxy: needsProxy, timeoutSec: 8 })
  } catch {
    return ''
  }
  const head = html.slice(0, 120_000) // og tags live in <head>
  // Extract each <meta> tag with a BOUNDED scan ({0,2000}) so a malicious/buggy
  // page full of unterminated "<meta " tokens can't cause catastrophic regex
  // backtracking (ReDoS) and hang the single-threaded event loop.
  for (const tag of head.match(/<meta\b[^>]{0,2000}>/gi) ?? []) {
    if (!/\b(?:property|name)\s*=\s*["'](?:og:image(?::url)?|twitter:image(?::src)?)["']/i.test(tag)) continue
    const m = tag.match(/\bcontent\s*=\s*["']([^"']+)["']/i)
    if (!m) continue
    let u = decodeEntities(decodeEntities(m[1].trim()))
    try { u = new URL(u, pageUrl).href } catch { /* keep as-is */ }
    const c = cleanImageUrl(u)
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
    try {
      url = url.trim()
      title = stripHtml(title)
      if (!url || !title) return
      // image extraction is best-effort; never let it drop the story
      let imageUrl = ''
      try { imageUrl = pickImage(node) } catch { /* no image */ }
      items.push({
        url,
        title,
        publishedAt: parseDate(date),
        excerpt: stripHtml(body).slice(0, 800),
        imageUrl,
      })
    } catch {
      // one malformed entry must never drop the rest of the feed
    }
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
