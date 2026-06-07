import { config } from './config.js'

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const CATEGORY_TAG: Record<string, { emoji: string; tag: string }> = {
  ai_llm: { emoji: '🤖', tag: '#AI' },
  tech: { emoji: '💻', tag: '#科技' },
  world: { emoji: '🌍', tag: '#时事' },
  security: { emoji: '🔐', tag: '#安全' },
  crypto: { emoji: '🪙', tag: '#加密' },
  opensource_dev: { emoji: '📦', tag: '#开源' },
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
  const lines = [
    `${c.emoji} ${c.tag} | ${escapeHtml(opts.source)}`,
    '',
    `${flash}<b>${escapeHtml(opts.titleZh)}</b>`,
  ]
  if (opts.summaryZh) {
    lines.push('', escapeHtml(opts.summaryZh))
  }
  lines.push('', `🔗 <a href="${escapeHtml(opts.url)}">原文链接</a>`)
  return lines.join('\n')
}

interface TgResponse {
  ok: boolean
  result?: { message_id: number }
  error_code?: number
  description?: string
  parameters?: { retry_after?: number }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

let lastSentAt = 0

/**
 * Send one HTML message to the channel, respecting the global pacing
 * (MIN_SECONDS_BETWEEN_POSTS) and Telegram 429 retry_after.
 */
export async function sendToChannel(html: string): Promise<number> {
  if (config.dryRun) {
    console.log('--- DRY RUN: would post ---\n' + html + '\n---')
    return 0
  }
  const gap = config.minSecondsBetweenPosts * 1000
  const wait = lastSentAt + gap - Date.now()
  if (wait > 0) await sleep(wait)

  for (let attempt = 0; attempt < 3; attempt++) {
    lastSentAt = Date.now()
    const res = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
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
    const data = (await res.json()) as TgResponse
    if (data.ok && data.result) return data.result.message_id
    if (data.error_code === 429) {
      const retry = (data.parameters?.retry_after ?? 5) + 1
      console.warn(`tg 429, retrying in ${retry}s`)
      await sleep(retry * 1000)
      continue
    }
    throw new Error(`tg sendMessage failed: ${data.error_code} ${data.description}`)
  }
  throw new Error('tg sendMessage: exhausted retries (429)')
}
