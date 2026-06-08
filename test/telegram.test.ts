import { describe, it, expect } from 'vitest'
import { formatPost, escapeHtml } from '../src/telegram.js'
import { salvageJson } from '../src/summarize.js'

describe('formatPost', () => {
  it('escapes HTML in title/summary/source', () => {
    const html = formatPost({
      category: 'security',
      source: 'A<B & C',
      titleZh: '漏洞 <script> 警报',
      summaryZh: '影响 1 & 2',
      url: 'https://ex.com/a?x=1&y=2',
      importance: 5,
    })
    expect(html).toContain('A&lt;B &amp; C')
    expect(html).toContain('<b>漏洞 &lt;script&gt; 警报</b>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('⚡️')
    expect(html).toContain('#安全')
    expect(html).toContain('href="https://ex.com/a?x=1&amp;y=2"')
  })
  it('escapes double quotes so URLs cannot break the href attribute', () => {
    expect(escapeHtml('a"b')).toBe('a&quot;b')
    const html = formatPost({
      category: 'tech', source: 's', titleZh: 't', summaryZh: '',
      url: 'https://ex.com/a?q="x"', importance: 3,
    })
    expect(html).toContain('href="https://ex.com/a?q=&quot;x&quot;"')
  })
  it('falls back to plain text for non-http URLs', () => {
    const html = formatPost({
      category: 'tech', source: 's', titleZh: 't', summaryZh: '',
      url: 'javascript:alert(1)', importance: 3,
    })
    expect(html).not.toContain('<a href')
    expect(html).toContain('javascript:alert(1)')
  })
  it('caps title and summary length well below the 4096 message limit', () => {
    const html = formatPost({
      category: 'tech', source: 's', titleZh: 'x'.repeat(5000), summaryZh: 'y'.repeat(5000),
      url: 'https://e.com', importance: 3,
    })
    expect(html.length).toBeLessThan(2000)
  })
  // Telegram counts the caption's VISIBLE text after entity parsing, in UTF-16
  // units (href URL + HTML tags don't count). Reconstruct that and assert ≤1024.
  const visibleUtf16 = (html: string) =>
    html.replace(/<a href="[^"]*">/g, '').replace(/<\/?[a-z]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').length

  it('compact caption stays ≤1024 visible UTF-16 units (long BMP text + long source)', () => {
    const html = formatPost({
      category: 'tech', source: 'A '.repeat(200), titleZh: '标'.repeat(5000),
      summaryZh: '要'.repeat(5000), url: 'https://e.com/' + 'p'.repeat(2000), importance: 5,
    }, { compact: true })
    expect(visibleUtf16(html)).toBeLessThanOrEqual(1024)
  })
  it('compact caption stays ≤1024 even with all-astral (emoji) summary', () => {
    const html = formatPost({
      category: 'crypto', source: '😀'.repeat(100), titleZh: '🎉'.repeat(400),
      summaryZh: '🚀'.repeat(2000), url: 'https://e.com', importance: 5,
    }, { compact: true })
    expect(visibleUtf16(html)).toBeLessThanOrEqual(1024)
  })
  it('truncation never tears a surrogate pair at the cap boundary', () => {
    const html = formatPost({
      category: 'tech', source: 's',
      titleZh: 'x'.repeat(299) + '😀'.repeat(5), summaryZh: '中'.repeat(899) + '🎉'.repeat(5),
      url: 'https://e.com', importance: 3,
    })
    // no unpaired high surrogate anywhere in the output
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(html)).toBe(false)
  })
  it('omits empty summary block and flash for normal importance', () => {
    const html = formatPost({
      category: 'tech', source: 'HN', titleZh: 'T', summaryZh: '', url: 'https://e.com', importance: 3,
    })
    expect(html).not.toContain('⚡️')
    expect(html.split('\n\n')).toHaveLength(3) // header / title / link
  })
  it('unknown category falls back to 资讯', () => {
    expect(formatPost({ category: 'whatever', source: 's', titleZh: 't', summaryZh: '', url: 'u', importance: 1 }))
      .toContain('#资讯')
  })
})

describe('salvageJson', () => {
  it('handles clean JSON', () => {
    expect(salvageJson('{"a":1}')).toEqual({ a: 1 })
  })
  it('strips code fences and prose', () => {
    expect(salvageJson('Sure! Here:\n```json\n{"title_zh":"x","skip":false}\n```')).toEqual({ title_zh: 'x', skip: false })
  })
  it('throws on no JSON', () => {
    expect(() => salvageJson('nope')).toThrow()
  })
})
