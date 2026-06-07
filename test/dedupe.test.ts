import { describe, it, expect } from 'vitest'
import { canonicalUrl, urlHash, normalizeTitle, titleSimilarity, isFuzzyDuplicate } from '../src/dedupe.js'

describe('canonicalUrl', () => {
  it('strips tracking params, www, protocol, trailing slash', () => {
    expect(canonicalUrl('https://www.example.com/a/?utm_source=rss&utm_medium=feed'))
      .toBe('example.com/a')
    expect(canonicalUrl('http://example.com/a')).toBe(canonicalUrl('https://example.com/a/'))
  })
  it('keeps meaningful params', () => {
    expect(canonicalUrl('https://example.com/watch?v=abc123')).toContain('v=abc123')
  })
  it('same canonical → same hash', () => {
    expect(urlHash('https://www.example.com/x?fbclid=111')).toBe(urlHash('http://example.com/x'))
  })
})

describe('titleSimilarity', () => {
  it('flags near-identical English titles across sources', () => {
    const a = normalizeTitle('OpenAI releases GPT-5 with major reasoning improvements')
    const b = normalizeTitle('OpenAI Releases GPT-5, With Major Reasoning Improvements!')
    expect(titleSimilarity(a, b)).toBeGreaterThanOrEqual(0.6)
  })
  it('flags near-identical Chinese titles', () => {
    const a = normalizeTitle('OpenAI 发布 GPT-5，推理能力大幅提升')
    const b = normalizeTitle('OpenAI发布GPT-5 推理能力大幅提升')
    expect(titleSimilarity(a, b)).toBeGreaterThanOrEqual(0.6)
  })
  it('does not flag different stories', () => {
    const a = normalizeTitle('OpenAI releases GPT-5')
    const b = normalizeTitle('Google announces Gemini 4 with video generation')
    expect(titleSimilarity(a, b)).toBeLessThan(0.6)
  })
  it('isFuzzyDuplicate works against a list', () => {
    const recents = [
      normalizeTitle('Critical RCE vulnerability found in Apache Struts'),
      normalizeTitle('Bitcoin hits new all-time high above $120k'),
    ]
    expect(isFuzzyDuplicate(normalizeTitle('Critical RCE Vulnerability Found in Apache Struts!'), recents)).toBe(true)
    expect(isFuzzyDuplicate(normalizeTitle('Ethereum upgrade ships on mainnet'), recents)).toBe(false)
  })
})
