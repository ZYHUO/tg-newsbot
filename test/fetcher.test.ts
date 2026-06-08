import { describe, it, expect } from 'vitest'
import { parseFeed } from '../src/fetcher.js'

const RSS2 = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Demo</title>
<item><title>First &amp; foremost</title><link>https://ex.com/1</link>
<pubDate>Mon, 02 Jun 2026 10:00:00 GMT</pubDate>
<description><![CDATA[<p>Hello <b>world</b> body text</p>]]></description></item>
<item><title>Second</title><link>https://ex.com/2</link></item>
</channel></rss>`

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>A</title>
<entry><title>Atom entry</title>
<link rel="self" href="https://ex.com/self.xml"/>
<link rel="alternate" href="https://ex.com/post"/>
<updated>2026-06-01T08:00:00Z</updated>
<summary>sum text</summary></entry>
</feed>`

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns="http://purl.org/rss/1.0/">
<channel rdf:about="x"><title>R</title></channel>
<item><title>RDF item</title><link>https://ex.com/r1</link><dc:date>2026-06-03T01:00:00Z</dc:date><description>d</description></item>
</rdf:RDF>`

describe('parseFeed', () => {
  it('parses RSS 2.0 with CDATA description and entities', () => {
    const items = parseFeed(RSS2)
    expect(items).toHaveLength(2)
    expect(items[0].title).toBe('First & foremost')
    expect(items[0].url).toBe('https://ex.com/1')
    expect(items[0].publishedAt).toBe(Date.parse('Mon, 02 Jun 2026 10:00:00 GMT'))
    expect(items[0].excerpt).toBe('Hello world body text')
    expect(items[1].publishedAt).toBeNull()
  })
  it('parses Atom, preferring rel=alternate links', () => {
    const items = parseFeed(ATOM)
    expect(items).toHaveLength(1)
    expect(items[0].url).toBe('https://ex.com/post')
    expect(items[0].title).toBe('Atom entry')
    expect(items[0].excerpt).toBe('sum text')
  })
  it('parses RDF (RSS 1.0)', () => {
    const items = parseFeed(RDF)
    expect(items).toHaveLength(1)
    expect(items[0].url).toBe('https://ex.com/r1')
    expect(items[0].publishedAt).toBe(Date.parse('2026-06-03T01:00:00Z'))
  })
  it('returns [] on HTML garbage', () => {
    expect(parseFeed('<!DOCTYPE html><html><body>nope</body></html>')).toEqual([])
  })
  it('keeps numeric titles/guids/links as strings (no number coercion)', () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item><title>2024</title><link>https://ex.com/2024</link><guid>123456</guid></item>
    </channel></rss>`
    const items = parseFeed(xml)
    expect(items[0].title).toBe('2024')
    expect(items[0].url).toBe('https://ex.com/2024')
  })
  it('decodes numeric and double-escaped entities', () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item><title>It&#8217;s here &amp;amp; now</title><link>https://ex.com/e</link></item>
    </channel></rss>`
    expect(parseFeed(xml)[0].title).toBe('It’s here & now')
  })
})

describe('image extraction', () => {
  const wrap = (item: string) => parseFeed(`<?xml version="1.0"?>
    <rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
    <channel><title>D</title>${item}</channel></rss>`)[0]

  it('prefers <enclosure type=image>', () => {
    expect(wrap(`<item><title>t</title><link>https://e.com/1</link>
      <enclosure url="https://cdn.e.com/a.jpg" type="image/jpeg"/></item>`).imageUrl)
      .toBe('https://cdn.e.com/a.jpg')
  })
  it('uses media:content medium=image', () => {
    expect(wrap(`<item><title>t</title><link>https://e.com/1</link>
      <media:content url="https://cdn.e.com/b.png" medium="image"/></item>`).imageUrl)
      .toBe('https://cdn.e.com/b.png')
  })
  it('uses media:thumbnail', () => {
    expect(wrap(`<item><title>t</title><link>https://e.com/1</link>
      <media:thumbnail url="https://cdn.e.com/thumb.webp"/></item>`).imageUrl)
      .toBe('https://cdn.e.com/thumb.webp')
  })
  it('falls back to first <img> in CDATA body', () => {
    expect(wrap(`<item><title>t</title><link>https://e.com/1</link>
      <content:encoded><![CDATA[<p>hi</p><img src="https://cdn.e.com/c.jpg"> more]]></content:encoded></item>`).imageUrl)
      .toBe('https://cdn.e.com/c.jpg')
  })
  it('finds <img> in escaped (non-CDATA) HTML body', () => {
    expect(wrap(`<item><title>t</title><link>https://e.com/1</link>
      <description>&lt;img src="https://cdn.e.com/d.png"/&gt;text</description></item>`).imageUrl)
      .toBe('https://cdn.e.com/d.png')
  })
  it('decodes entities in enclosure/attribute URLs', () => {
    expect(wrap(`<item><title>t</title><link>https://e.com/1</link>
      <enclosure url="https://cdn.e.com/a.jpg?x=1&#038;y=2" type="image/jpeg"/></item>`).imageUrl)
      .toBe('https://cdn.e.com/a.jpg?x=1&y=2')
  })
  it('promotes protocol-relative // URLs to https', () => {
    expect(wrap(`<item><title>t</title><link>https://e.com/1</link>
      <enclosure url="//cdn.e.com/e.jpg" type="image/jpeg"/></item>`).imageUrl)
      .toBe('https://cdn.e.com/e.jpg')
  })
  it('skips tracking pixels, gifs, and relative URLs', () => {
    expect(wrap(`<item><title>t</title><link>https://e.com/1</link>
      <description>&lt;img src="https://feedburner.com/~ff/x.png"/&gt;</description></item>`).imageUrl).toBe('')
    expect(wrap(`<item><title>t</title><link>https://e.com/1</link>
      <description>&lt;img src="https://e.com/anim.gif"/&gt;</description></item>`).imageUrl).toBe('')
    expect(wrap(`<item><title>t</title><link>https://e.com/1</link>
      <description>&lt;img src="/local/rel.jpg"/&gt;</description></item>`).imageUrl).toBe('')
  })
  it('is empty when there is no image', () => {
    expect(wrap(`<item><title>t</title><link>https://e.com/1</link><description>just text</description></item>`).imageUrl).toBe('')
  })
})
