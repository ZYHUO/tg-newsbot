import type Database from 'better-sqlite3'
import { config, type FeedConfig } from './config.js'
import { fetchFeed } from './fetcher.js'
import { urlHash, normalizeTitle, isFuzzyDuplicate } from './dedupe.js'
import { summarize, type Summary } from './summarize.js'
import { formatPost, sendToChannel, SendError } from './telegram.js'
import { metaGet, metaSet } from './db.js'

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a)

/** exponential backoff for summarize/send retries: 10min → … → 6h cap */
function backoffMs(failCount: number): number {
  return Math.min(10 * 60_000 * 2 ** Math.max(0, failCount - 1), 6 * 3600_000)
}
const MAX_FAILS = 8
/** after this many summarize failures, post the raw title instead of dropping the story */
const SUMMARIZE_FALLBACK_AFTER = 5

/** Fetch one feed and stage new items into the DB. */
export async function pollFeed(db: Database.Database, feed: FeedConfig): Promise<void> {
  const now = Date.now()
  const state = db.prepare('SELECT * FROM feed_state WHERE feed_url = ?').get(feed.url) as
    | { seeded: number; fail_count: number } | undefined

  let items
  try {
    items = await fetchFeed(feed.url, feed.needsProxy ?? false)
  } catch (err) {
    db.prepare(`
      INSERT INTO feed_state (feed_url, last_fetch_at, fail_count) VALUES (?, ?, 1)
      ON CONFLICT(feed_url) DO UPDATE SET last_fetch_at = excluded.last_fetch_at, fail_count = fail_count + 1
    `).run(feed.url, now)
    log(`feed FAIL ${feed.name}: ${(err as Error).message.slice(0, 200)}`)
    return
  }

  const seeded = state?.seeded === 1
  // first fetch that actually RETURNS items: swallow the backlog silently so
  // we don't flood the channel with months of old entries. An empty first
  // fetch must NOT count as seeding — otherwise the next non-empty fetch
  // would dump the entire backlog as "new".
  const insertStatus = seeded ? 'pending' : 'seeded'

  // cross-source dedup pool: only stories the channel actually carries
  // (posted or queued). Seeded/skipped backlog must not suppress real news.
  const recentTitles = (db.prepare(
    `SELECT title_norm FROM items WHERE fetched_at > ? AND status IN ('pending', 'posting', 'posted')`,
  ).all(now - 48 * 3600 * 1000) as { title_norm: string }[]).map(r => r.title_norm)

  const insert = db.prepare(`
    INSERT OR IGNORE INTO items
      (feed_url, category, source_name, url, url_hash, title, title_norm, published_at, fetched_at, status, summary_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  let fresh = 0
  for (const it of items) {
    const hash = urlHash(it.url)
    const norm = normalizeTitle(it.title)
    let status = insertStatus
    // too old → record but never post
    if (status === 'pending' && it.publishedAt && now - it.publishedAt > config.maxItemAgeHours * 3600 * 1000) {
      status = 'seeded'
    }
    // same story already carried from another source
    if (status === 'pending' && isFuzzyDuplicate(norm, recentTitles)) {
      status = 'skipped'
    }
    const res = insert.run(
      feed.url, feed.category, feed.name, it.url, hash, it.title, norm,
      it.publishedAt, now, status, JSON.stringify({ excerpt: it.excerpt }),
    )
    if (res.changes > 0 && status === 'pending') {
      fresh++
      recentTitles.push(norm) // dedupe within this batch too
    }
  }

  const nowSeeded = seeded || items.length > 0 ? 1 : 0
  db.prepare(`
    INSERT INTO feed_state (feed_url, last_fetch_at, last_ok_at, fail_count, seeded) VALUES (?, ?, ?, 0, ?)
    ON CONFLICT(feed_url) DO UPDATE SET last_fetch_at = excluded.last_fetch_at, last_ok_at = excluded.last_ok_at, fail_count = 0, seeded = excluded.seeded
  `).run(feed.url, now, now, nowSeeded)

  if (fresh > 0) log(`feed ${feed.name}: +${fresh} new items (${items.length} in feed)`)
}

/**
 * Startup reconciliation: rows stuck in 'posting' mean we crashed between
 * sending and committing. The send most likely went through — prefer a
 * possibly-missed story over a duplicate post, so mark them posted.
 */
export function reconcilePosting(db: Database.Database): void {
  const n = db.prepare(`UPDATE items SET status = 'posted' WHERE status = 'posting'`).run().changes
  if (n > 0) log(`reconciled ${n} item(s) stuck in 'posting' from a previous crash → marked posted`)
}

/** Daily retention: drop terminal rows older than 30 days, keep the DB small. */
export function retentionSweep(db: Database.Database): void {
  const today = new Date().toISOString().slice(0, 10)
  if (metaGet(db, 'last_retention_day') === today) return
  metaSet(db, 'last_retention_day', today)
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000
  const n = db.prepare(
    `DELETE FROM items WHERE fetched_at < ? AND status != 'pending'`,
  ).run(cutoff).changes
  db.pragma('wal_checkpoint(TRUNCATE)')
  if (n > 0) log(`retention: deleted ${n} rows older than 30d`)
}

/** Summarize + post staged pending items, oldest first. */
export async function publishPending(db: Database.Database): Promise<void> {
  const now = Date.now()

  // never post stories older than the freshness window — they expire even if
  // they were queued while the LLM/Telegram was down (no stale-news flood
  // after an outage recovers). Dateless items age by fetched_at.
  const expired = db.prepare(`
    UPDATE items SET status = 'skipped'
    WHERE status = 'pending' AND COALESCE(published_at, fetched_at) < ?
  `).run(now - config.maxItemAgeHours * 3600 * 1000).changes
  if (expired > 0) log(`expired ${expired} stale pending item(s) past ${config.maxItemAgeHours}h`)

  // over-select so items failing this cycle don't eat the posting budget
  const candidates = db.prepare(`
    SELECT * FROM items
    WHERE status = 'pending' AND fail_count < ?
      AND (next_retry_at IS NULL OR next_retry_at <= ?)
    ORDER BY COALESCE(published_at, fetched_at) ASC
    LIMIT ?
  `).all(MAX_FAILS, now, config.maxPostsPerCycle * 3) as import('./db.js').ItemRow[]

  let posted = 0
  for (const item of candidates) {
    if (posted >= config.maxPostsPerCycle) break

    const excerpt = item.summary_json
      ? String((JSON.parse(item.summary_json) as { excerpt?: string }).excerpt ?? '')
      : ''

    let s: Summary
    try {
      s = await summarize(item.title, excerpt, item.source_name, item.category)
    } catch (err) {
      log(`summarize FAIL #${item.id} ${item.title.slice(0, 60)}: ${(err as Error).message.slice(0, 150)}`)
      const fails = item.fail_count + 1
      if (fails >= SUMMARIZE_FALLBACK_AFTER) {
        // LLM has been failing for hours — post the raw title rather than
        // silently dropping a potentially important story
        s = { titleZh: item.title, summaryZh: '', skip: false, importance: 3 }
      } else {
        db.prepare('UPDATE items SET fail_count = ?, next_retry_at = ? WHERE id = ?')
          .run(fails, Date.now() + backoffMs(fails), item.id)
        continue
      }
    }
    if (s.skip) {
      db.prepare(`UPDATE items SET status = 'skipped', summary_json = ? WHERE id = ?`)
        .run(JSON.stringify(s), item.id)
      continue
    }

    // claim the row BEFORE the side effect so a crash window leaves a
    // 'posting' marker instead of re-sending on restart
    const claimed = db.prepare(
      `UPDATE items SET status = 'posting' WHERE id = ? AND status = 'pending'`,
    ).run(item.id).changes
    if (claimed !== 1) continue

    try {
      const msgId = await sendToChannel(formatPost({
        category: item.category,
        source: item.source_name,
        titleZh: s.titleZh,
        summaryZh: s.summaryZh,
        url: item.url,
        importance: s.importance,
      }))
      db.prepare(`UPDATE items SET status = 'posted', posted_msg_id = ?, summary_json = ? WHERE id = ?`)
        .run(msgId, JSON.stringify(s), item.id)
      posted++
      log(`posted #${item.id} [${item.category}] ${s.titleZh.slice(0, 60)}`)
    } catch (err) {
      const maybeSent = err instanceof SendError && err.maybeSent
      log(`post FAIL #${item.id} (maybeSent=${maybeSent}): ${(err as Error).message.slice(0, 200)}`)
      if (maybeSent) {
        // ambiguous delivery — prefer a possibly-missed story over a duplicate
        db.prepare(`UPDATE items SET status = 'posted', summary_json = ? WHERE id = ?`)
          .run(JSON.stringify({ ...s, deliveryUncertain: true }), item.id)
        posted++
      } else {
        const fails = item.fail_count + 1
        db.prepare(`UPDATE items SET status = ?, fail_count = ?, next_retry_at = ? WHERE id = ?`)
          .run(fails >= MAX_FAILS ? 'failed' : 'pending', fails, Date.now() + backoffMs(fails), item.id)
      }
    }
  }
}

/** One full cycle: poll all due feeds, then publish what came in. */
export async function runCycle(db: Database.Database, feeds: FeedConfig[]): Promise<void> {
  const now = Date.now()
  const due = feeds.filter(f => {
    if (f.disabled) return false
    const st = db.prepare('SELECT last_fetch_at FROM feed_state WHERE feed_url = ?').get(f.url) as
      | { last_fetch_at: number | null } | undefined
    const interval = (f.intervalSec ?? config.pollIntervalSec) * 1000
    return !st?.last_fetch_at || now - st.last_fetch_at >= interval - 5000
  })

  // fetch feeds with bounded concurrency
  const queue = [...due]
  const workers = Array.from({ length: 5 }, async () => {
    while (queue.length > 0) {
      const feed = queue.shift()!
      await pollFeed(db, feed)
    }
  })
  await Promise.all(workers)

  retentionSweep(db)
  await publishPending(db)
}
