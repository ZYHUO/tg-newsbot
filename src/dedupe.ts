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
    u.hash = ''
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '')
    let s = u.toString().replace(/^https?:\/\//, '')
    if (s.endsWith('/')) s = s.slice(0, -1)
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

export function isFuzzyDuplicate(normTitle: string, recentNormTitles: string[]): boolean {
  return recentNormTitles.some(t => titleSimilarity(normTitle, t) >= TITLE_DUP_THRESHOLD)
}
