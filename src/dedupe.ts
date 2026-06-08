import { createHash } from 'node:crypto'

/**
 * Canonicalize a URL for dedup: drop tracking params, fragments,
 * trailing slashes, and protocol differences.
 */
export function canonicalUrl(raw: string): string {
  try {
    const u = new URL(raw)
    const drop = new Set([
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'ref', 'source', 'src', 'guccounter', 'fbclid', 'gclid',
    ])
    for (const k of [...u.searchParams.keys()]) {
      if (drop.has(k.toLowerCase())) u.searchParams.delete(k)
    }
    u.searchParams.sort() // ?a=1&b=2 ≡ ?b=2&a=1
    u.hash = ''
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '')
    u.pathname = u.pathname.replace(/\/{2,}/g, '/')
    let s = u.toString().replace(/^https?:\/\//, '')
    s = s.replace(/\/+$/, '').replace(/\/+\?/, '?')
    return s
  } catch {
    return raw.trim()
  }
}

export function urlHash(raw: string): string {
  return createHash('sha256').update(canonicalUrl(raw)).digest('hex').slice(0, 32)
}

/**
 * Normalize a title into a token set string for fuzzy cross-source dedup.
 * Works for both English (word tokens) and CJK (bigram tokens).
 */
export function normalizeTitle(title: string): string {
  const lower = title.toLowerCase()
    .replace(/[‘’“”'"`]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return lower
}

const CJK = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\u3040-\\u30ff\\uac00-\\ud7af'
const RUNS = new RegExp(`[${CJK}]+|[^\\s${CJK}]+`, 'g')

function tokens(normTitle: string): Set<string> {
  const out = new Set<string>()
  // segment into CJK runs vs other runs regardless of spacing, so that
  // "OpenAI发布GPT-5" and "OpenAI 发布 GPT-5" tokenize identically
  for (const run of normTitle.match(RUNS) ?? []) {
    if (new RegExp(`^[${CJK}]`).test(run)) {
      // CJK run → overlapping bigrams
      if (run.length === 1) out.add(run)
      for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2))
    } else {
      out.add(run)
    }
  }
  return out
}

export function titleSimilarity(normA: string, normB: string): number {
  const a = tokens(normA)
  const b = tokens(normB)
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter) // jaccard
}

/** Same story from two sources if titles are this similar. */
export const TITLE_DUP_THRESHOLD = 0.6

/**
 * Short/templated titles ("苹果发布会" vs "苹果发布会前瞻") lack the token
 * mass for reliable fuzzy matching at 0.6 — but skipping them entirely would
 * let identical short headlines from two sources double-post. Compromise:
 * short titles still match, but only at near-identity.
 */
const MIN_FUZZY_TOKENS = 5
const SHORT_TITLE_THRESHOLD = 0.9

export function isFuzzyDuplicate(
  normTitle: string,
  recentNormTitles: string[],
  threshold: number = TITLE_DUP_THRESHOLD,
): boolean {
  const a = tokens(normTitle)
  if (a.size === 0) return false
  // short titles always need near-identity, never weaker than the caller's bar
  const shortBar = Math.max(threshold, SHORT_TITLE_THRESHOLD)
  return recentNormTitles.some(t => {
    const b = tokens(t)
    if (b.size === 0) return false
    let inter = 0
    for (const x of a) if (b.has(x)) inter++
    const jaccard = inter / (a.size + b.size - inter)
    const eff = a.size < MIN_FUZZY_TOKENS || b.size < MIN_FUZZY_TOKENS ? shortBar : threshold
    return jaccard >= eff
  })
}
