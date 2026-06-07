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
