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

export function formatPost(opts: {
  category: string
  source: string
  titleZh: string
  summaryZh: string
  url: string
  importance: number
}): string {
  const c = CATEGORY_TAG[opts.category] ?? { emoji: '📰', tag: '#资讯' }
  const flash = opts.importance >= 5 ? '⚡️ ' : ''
  // hard caps keep the message far below Telegram's 4096-char limit;
  // slice on code points so an emoji at the boundary can't be torn in half
  const title = [...opts.titleZh].slice(0, 300).join('')
  const summary = [...opts.summaryZh].slice(0, 900).join('')
  const lines = [
    `${c.emoji} ${c.tag} | ${escapeHtml(opts.source)}`,
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

/**
 * Send one HTML message to the channel: paced (MIN_SECONDS_BETWEEN_POSTS,
 * persisted across restarts), retrying 429 and transient 5xx.
 */
export async function sendToChannel(html: string): Promise<number> {
  if (config.dryRun) {
    console.log('--- DRY RUN: would post ---\n' + html + '\n---')
    return 0
  }
  const db = getDb()
  if (lastSentAt === null) {
    lastSentAt = Number(metaGet(db, 'last_sent_at') ?? 0)
  }
  const gap = config.minSecondsBetweenPosts * 1000
  const wait = lastSentAt + gap - Date.now()
  if (wait > 0) await sleep(wait)

  for (let attempt = 0; attempt < 4; attempt++) {
    lastSentAt = Date.now()
    metaSet(db, 'last_sent_at', String(lastSentAt))

    let res: Response
    try {
      res = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: config.channelId,
          text: html,
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: false, prefer_small_media: true },
        }),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (err) {
      // timeout: request may have reached Telegram → ambiguous.
      // pre-connection network errors (ECONNREFUSED etc.) → definitely not sent.
      const timedOut = (err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError'
      throw new SendError(`tg request failed: ${(err as Error).message}`, timedOut)
    }

    if (res.status >= 500) {
      // a 502/504 from Telegram's edge does NOT prove the request was never
      // processed — re-sending the same message risks a duplicate post.
      // Treat like an in-flight timeout: ambiguous, caller decides.
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
    // definite rejection (400 bad markup, 403 kicked from channel, …)
    throw new SendError(`tg sendMessage failed: ${data.error_code} ${data.description}`, false)
  }
  throw new SendError('tg sendMessage: exhausted retries (429)', false)
}
