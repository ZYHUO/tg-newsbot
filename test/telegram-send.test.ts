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
})
