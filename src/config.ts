import 'dotenv/config'

const DEFAULT_CATEGORY_MIN_IMPORTANCE: Record<string, number> = {
  ai_llm: 3, world: 3, security: 3, // important beats — lenient
  crypto: 4, tech: 4, opensource_dev: 4, // noisier beats — strict
}

/** Parse `cat:n,cat:n` env override; falls back to the built-in map. */
function parseThresholds(raw: string | undefined): Record<string, number> {
  if (!raw) return DEFAULT_CATEGORY_MIN_IMPORTANCE
  const out: Record<string, number> = { ...DEFAULT_CATEGORY_MIN_IMPORTANCE }
  for (const pair of raw.split(',')) {
    const [k, v] = pair.split(':').map(s => s.trim())
    if (k && v && !Number.isNaN(Number(v))) out[k] = Number(v)
  }
  return out
}

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
  // Per-category importance gate (LLM scores 1-5): only post items at or above
  // the category's threshold. Important beats (AI/world/security) are lenient;
  // noisier beats (crypto/tech/opensource) require a higher bar.
  categoryMinImportance: parseThresholds(process.env.CATEGORY_MIN_IMPORTANCE),
  defaultMinImportance: Number(process.env.DEFAULT_MIN_IMPORTANCE ?? 3),
  // Best-effort cover image: when the feed entry has no image, scrape the
  // article page's og:image before posting.
  fetchOgImage: process.env.FETCH_OG_IMAGE !== '0',
  // Storage
  dbPath: process.env.DB_PATH ?? new URL('../data/newsbot.db', import.meta.url).pathname,
  feedsPath: process.env.FEEDS_PATH ?? new URL('../feeds.json', import.meta.url).pathname,
}

/** Minimum importance an item of this category must reach to be posted. */
export function minImportanceFor(category: string): number {
  return config.categoryMinImportance[category] ?? config.defaultMinImportance
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
