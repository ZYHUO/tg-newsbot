import type Database from 'better-sqlite3'
import { config, type FeedConfig } from './config.js'
import { fetchFeed } from './fetcher.js'
import { urlHash, normalizeTitle, isFuzzyDuplicate } from './dedupe.js'
import { summarize } from './summarize.js'
import { formatPost, sendToChannel } from './telegram.js'

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a)

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
  // first ever fetch of this feed: swallow the backlog silently so we
  // don't flood the channel with months of old entries
  const insertStatus = seeded ? 'pending' : 'seeded'

  const recentTitles = (db.prepare(
    `SELECT title_norm FROM items WHERE fetched_at > ?`,
  ).all(now - 48 * 3600 * 1000) as { title_norm: string }[]).map(r => r.title_norm)

  const insert = db.prepare(`
    INSERT OR IGNORE INTO items
      (feed_url, category, source_name, url, url_hash, title, title_norm, published_at, fetched_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    // same story already staged/posted from another source
    if (status === 'pending' && isFuzzyDuplicate(norm, recentTitles)) {
      status = 'skipped'
    }
    const res = insert.run(
      feed.url, feed.category, feed.name, it.url, hash, it.title, norm,
      it.publishedAt, now, status,
    )
    if (res.changes > 0) {
      if (status === 'pending') fresh++
      recentTitles.push(norm) // dedupe within this batch too
      if (res.changes > 0 && status === 'pending') {
        db.prepare('UPDATE items SET summary_json = ? WHERE url_hash = ?')
          .run(JSON.stringify({ excerpt: it.excerpt }), hash)
      }
    }
  }

  db.prepare(`
    INSERT INTO feed_state (feed_url, last_fetch_at, last_ok_at, fail_count, seeded) VALUES (?, ?, ?, 0, 1)
    ON CONFLICT(feed_url) DO UPDATE SET last_fetch_at = excluded.last_fetch_at, last_ok_at = excluded.last_ok_at, fail_count = 0, seeded = 1
  `).run(feed.url, now, now)

  if (fresh > 0) log(`feed ${feed.name}: +${fresh} new items (${items.length} in feed)`)
}

/** Summarize + post staged pending items, oldest first. */
export async function publishPending(db: Database.Database): Promise<void> {
  const pending = db.prepare(`
    SELECT * FROM items WHERE status = 'pending' AND fail_count < 3
    ORDER BY COALESCE(published_at, fetched_at) ASC
    LIMIT ?
  `).all(config.maxPostsPerCycle) as import('./db.js').ItemRow[]

  for (const item of pending) {
    try {
      const excerpt = item.summary_json
        ? String((JSON.parse(item.summary_json) as { excerpt?: string }).excerpt ?? '')
        : ''
      let s
      try {
        s = await summarize(item.title, excerpt, item.source_name, item.category)
      } catch (err) {
        log(`summarize FAIL #${item.id} ${item.title.slice(0, 60)}: ${(err as Error).message.slice(0, 150)}`)
        const fails = item.fail_count + 1
        db.prepare('UPDATE items SET fail_count = ? WHERE id = ?').run(fails, item.id)
        if (fails >= 3) {
          // fallback: post untranslated title so big news isn't silently dropped
          s = { titleZh: item.title, summaryZh: '', skip: false, importance: 3 }
        } else {
          continue
        }
      }
      if (s.skip) {
        db.prepare(`UPDATE items SET status = 'skipped' WHERE id = ?`).run(item.id)
        continue
      }
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
      log(`posted #${item.id} [${item.category}] ${s.titleZh.slice(0, 60)}`)
    } catch (err) {
      // posting failed (network / tg error) — bump fail_count, retry next cycle
      log(`post FAIL #${item.id}: ${(err as Error).message.slice(0, 200)}`)
      db.prepare('UPDATE items SET fail_count = fail_count + 1 WHERE id = ?').run(item.id)
      db.prepare(`UPDATE items SET status = 'failed' WHERE id = ? AND fail_count >= 3`).run(item.id)
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

  await publishPending(db)
}
