import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'

// disable pacing before the module under test reads config
process.env.MIN_SECONDS_BETWEEN_POSTS = '0'
const { sendToChannel, SendError } = await import('../src/telegram.js')
const { resetDbForTest } = await import('../src/db.js')

const tg = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('sendToChannel delivery semantics', () => {
  beforeEach(() => resetDbForTest(':memory:'))
  afterEach(() => vi.unstubAllGlobals())

  it('5xx is ambiguous: SendError maybeSent=true, NO blind re-send', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('<html>Bad Gateway</html>', { status: 502 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(sendToChannel('x')).rejects.toMatchObject({ maybeSent: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('429 retries with retry_after and then succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tg({ ok: false, error_code: 429, parameters: { retry_after: 0 } }, 429))
      .mockResolvedValueOnce(tg({ ok: true, result: { message_id: 7 } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(sendToChannel('x')).resolves.toBe(7)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('definite 400 rejection: maybeSent=false (safe to retry/fail the item)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      tg({ ok: false, error_code: 400, description: "can't parse entities" }, 400)))
    await expect(sendToChannel('x')).rejects.toMatchObject({ maybeSent: false })
  })

  it('unreadable body on 2xx: maybeSent=true', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not json at all', { status: 200 })))
    await expect(sendToChannel('x')).rejects.toMatchObject({ maybeSent: true })
  })

  it('pre-connection network error: maybeSent=false', async () => {
    const err = new TypeError('fetch failed')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(err))
    await expect(sendToChannel('x')).rejects.toMatchObject({ maybeSent: false })
  })

  it('SendError is exported and carries maybeSent', () => {
    expect(new SendError('m', true).maybeSent).toBe(true)
  })

  it('plain text message disables the link preview', async () => {
    const fetchMock = vi.fn().mockResolvedValue(tg({ ok: true, result: { message_id: 1 } }))
    vi.stubGlobal('fetch', fetchMock)
    await sendToChannel('hello')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('/sendMessage')
    expect(JSON.parse(init.body).link_preview_options).toEqual({ is_disabled: true })
  })

  it('with photoUrl: calls sendPhoto with caption, no text message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(tg({ ok: true, result: { message_id: 9 } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(sendToChannel('full text', { photoUrl: 'https://x/i.jpg', captionText: 'cap' })).resolves.toBe(9)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('/sendPhoto')
    const body = JSON.parse(init.body)
    expect(body.photo).toBe('https://x/i.jpg')
    expect(body.caption).toBe('cap')
  })

  it('photo definite rejection (400) falls back to text sendMessage', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tg({ ok: false, error_code: 400, description: 'failed to get HTTP URL content' }, 400))
      .mockResolvedValueOnce(tg({ ok: true, result: { message_id: 42 } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(sendToChannel('full text', { photoUrl: 'https://x/bad.jpg', captionText: 'cap' })).resolves.toBe(42)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toContain('/sendPhoto')
    expect(fetchMock.mock.calls[1][0]).toContain('/sendMessage')
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).text).toBe('full text')
  })

  it('photo AMBIGUOUS failure (5xx) does NOT fall back (no duplicate risk)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('<html>bad gw</html>', { status: 502 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(sendToChannel('full text', { photoUrl: 'https://x/i.jpg', captionText: 'cap' }))
      .rejects.toMatchObject({ maybeSent: true })
    expect(fetchMock).toHaveBeenCalledTimes(1) // only the sendPhoto attempt
    expect(fetchMock.mock.calls[0][0]).toContain('/sendPhoto')
  })
})
