import 'dotenv/config'

export const config = {
  dryRun: process.env.DRY_RUN === '1',
  // Telegram
  botToken: process.env.BOT_TOKEN ?? '',
  channelId: process.env.CHANNEL_ID ?? '',
  // LLM (OpenAI-compatible endpoint)
  llm: {
    endpoint: process.env.LLM_ENDPOINT ?? 'http://127.0.0.1:8317/v1',
    apiKey: process.env.LLM_API_KEY ?? '',
    model: process.env.LLM_MODEL ?? 'gemini-3.1-flash-lite-preview',
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 45_000),
  },
  // Fetching
  proxy: process.env.SOCKS_PROXY ?? 'socks5h://127.0.0.1:1080',
  pollIntervalSec: Number(process.env.POLL_INTERVAL_SEC ?? 600),
  fetchTimeoutSec: Number(process.env.FETCH_TIMEOUT_SEC ?? 20),
  // Posting policy
  maxItemAgeHours: Number(process.env.MAX_ITEM_AGE_HOURS ?? 24),
  minSecondsBetweenPosts: Number(process.env.MIN_SECONDS_BETWEEN_POSTS ?? 4),
  maxPostsPerCycle: Number(process.env.MAX_POSTS_PER_CYCLE ?? 30),
  // Storage
  dbPath: process.env.DB_PATH ?? new URL('../data/newsbot.db', import.meta.url).pathname,
  feedsPath: process.env.FEEDS_PATH ?? new URL('../feeds.json', import.meta.url).pathname,
}

/** Called once at startup — import of this module must never throw (tests). */
export function validateConfig(): void {
  if (config.dryRun) return
  if (!config.botToken) throw new Error('missing required env: BOT_TOKEN')
  if (!config.channelId) throw new Error('missing required env: CHANNEL_ID')
}

export interface FeedConfig {
  url: string
  category: string
  name: string
  lang: 'zh' | 'en' | 'mixed'
  needsProxy?: boolean
  /** per-feed override of the global poll interval */
  intervalSec?: number
  disabled?: boolean
}
