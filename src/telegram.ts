import { config } from './config.js'
import { getDb, metaGet, metaSet } from './db.js'

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const CATEGORY_TAG: Record<string, { emoji: string; tag: string }> = {
  ai_llm: { emoji: '🤖', tag: '#AI' },
  tech: { emoji: '💻', tag: '#科技' },
  world: { emoji: '🌍', tag: '#时事' },
  security: { emoji: '🔐', tag: '#安全' },
  crypto: { emoji: '🪙', tag: '#加密' },
  opensource_dev: { emoji: '📦', tag: '#开源' },
}

function isValidHttpUrl(s: string): boolean {
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export interface PostInput {
  category: string
  source: string
  titleZh: string
  summaryZh: string
  url: string
  importance: number
}

const cp = (s: string, n: number) => [...s].slice(0, n).join('')

/** trim a string so its UTF-16 length ≤ max, never splitting a surrogate pair */
function trimToUtf16(s: string, max: number): string {
  if (s.length <= max) return s
  let out = ''
  for (const ch of s) {
    if (out.length + ch.length > max) break
    out += ch
  }
  return out
}

/**
 * Render a post as Telegram HTML.
 * - default: sized for sendMessage (4096 limit)
 * - compact: sized for a sendPhoto caption — Telegram counts the caption's
 *   VISIBLE text (after entity parsing) in UTF-16 units, max 1024; HTML tags
 *   and the href URL don't count. We budget the summary against that so the
 *   caption can't structurally exceed it (even all-emoji / long source).
 */
export function formatPost(opts: PostInput, { compact = false } = {}): string {
  const c = CATEGORY_TAG[opts.category] ?? { emoji: '📰', tag: '#资讯' }
  const flash = opts.importance >= 5 ? '⚡️ ' : ''
  const source = compact ? cp(opts.source, 80) : opts.source
  const title = cp(opts.titleZh, compact ? 200 : 300)
  let summary = cp(opts.summaryZh, compact ? 600 : 900)

  if (compact && summary) {
    // visible text Telegram measures = pieces below WITHOUT html tags/href
    const visibleLen = (sum: string) =>
      (`${c.emoji} ${c.tag} | ${source}\n\n${flash}${title}` +
        (sum ? `\n\n${sum}` : '') + `\n\n🔗 原文链接`).length
    if (visibleLen(summary) > 1000) {
      summary = trimToUtf16(summary, Math.max(0, summary.length - (visibleLen(summary) - 1000)))
    }
  }

  const lines = [
    `${c.emoji} ${c.tag} | ${escapeHtml(source)}`,
    '',
    `${flash}<b>${escapeHtml(title)}</b>`,
  ]
  if (summary) {
    lines.push('', escapeHtml(summary))
  }
  if (isValidHttpUrl(opts.url)) {
    lines.push('', `🔗 <a href="${escapeHtml(opts.url)}">原文链接</a>`)
  } else {
    lines.push('', `🔗 ${escapeHtml(opts.url.slice(0, 200))}`)
  }
  return lines.join('\n')
}

interface TgResponse {
  ok: boolean
  result?: { message_id: number }
  error_code?: number
  description?: string
  parameters?: { retry_after?: number }
}

/**
 * Thrown when we cannot be sure Telegram did NOT deliver the message
 * (response received but unreadable, or request timed out in flight).
 * Callers must NOT blindly retry on maybeSent — that risks a duplicate post.
 */
export class SendError extends Error {
  constructor(message: string, public readonly maybeSent: boolean) {
    super(message)
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

let lastSentAt: number | null = null

/** One Telegram Bot API method call with 429/5xx handling. Throws SendError. */
async function callTg(method: string, payload: Record<string, unknown>): Promise<number> {
  const db = getDb()
  for (let attempt = 0; attempt < 4; attempt++) {
    lastSentAt = Date.now()
    metaSet(db, 'last_sent_at', String(lastSentAt))

    let res: Response
    try {
      res = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (err) {
      // timeout: request may have reached Telegram → ambiguous.
      // pre-connection network errors (ECONNREFUSED etc.) → definitely not sent.
      const timedOut = (err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError'
      throw new SendError(`tg ${method} request failed: ${(err as Error).message}`, timedOut)
    }

    if (res.status >= 500) {
      // a 502/504 from Telegram's edge does NOT prove the request was never
      // processed — re-sending the same message risks a duplicate post.
      throw new SendError(`tg gateway error ${res.status}`, true)
    }

    let data: TgResponse
    try {
      data = (await res.json()) as TgResponse
    } catch {
      // got an HTTP response but couldn't read the body; on a 2xx the
      // message was almost certainly delivered
      throw new SendError(`tg response unreadable (http ${res.status})`, res.ok)
    }

    if (data.ok && data.result) return data.result.message_id
    if (data.error_code === 429) {
      const retry = (data.parameters?.retry_after ?? 5) + 1
      console.warn(`tg 429, retrying in ${retry}s`)
      await sleep(retry * 1000)
      continue
    }
    // definite rejection (400 bad markup/caption, 403 kicked from channel, …)
    throw new SendError(`tg ${method} failed: ${data.error_code} ${data.description}`, false)
  }
  throw new SendError(`tg ${method}: exhausted retries (429)`, false)
}

/**
 * Post to the channel: paced (MIN_SECONDS_BETWEEN_POSTS, persisted across
 * restarts). With a photoUrl, sends an image + caption; if Telegram rejects
 * the photo (can't fetch it, bad format, caption too long — any definite 4xx),
 * falls back to a plain text message so the story is never dropped. Plain
 * text messages have the link preview disabled.
 *
 * Note: if sendPhoto exhausts its 429 retries it is treated as a definite
 * rejection and the story posts as text (image dropped, story kept). This is
 * intentional — a 429 means no message was created, so the text fallback can't
 * duplicate. Rare given low feed volume + pacing.
 */
export async function sendToChannel(
  text: string,
  opts: { photoUrl?: string; captionText?: string } = {},
): Promise<number> {
  if (config.dryRun) {
    const what = opts.photoUrl ? `[PHOTO ${opts.photoUrl}]\n` + (opts.captionText ?? text) : text
    console.log('--- DRY RUN: would post ---\n' + what + '\n---')
    return 0
  }
  const db = getDb()
  if (lastSentAt === null) lastSentAt = Number(metaGet(db, 'last_sent_at') ?? 0)
  const gap = config.minSecondsBetweenPosts * 1000
  const wait = lastSentAt + gap - Date.now()
  if (wait > 0) await sleep(wait)

  if (opts.photoUrl) {
    try {
      return await callTg('sendPhoto', {
        chat_id: config.channelId,
        photo: opts.photoUrl,
        caption: opts.captionText ?? text,
        parse_mode: 'HTML',
      })
    } catch (err) {
      // ambiguous failures (timeout/5xx/unreadable) must NOT fall through —
      // the photo may have been delivered; re-sending text would duplicate.
      if (err instanceof SendError && err.maybeSent) throw err
      // definite rejection of the photo → send the story as text instead
      console.warn(`photo rejected, falling back to text: ${(err as Error).message.slice(0, 160)}`)
    }
  }

  return await callTg('sendMessage', {
    chat_id: config.channelId,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  })
}
