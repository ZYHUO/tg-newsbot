import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Database from 'better-sqlite3'

const { MockSendError } = vi.hoisted(() => {
  class MockSendError extends Error {
    constructor(message: string, public readonly maybeSent: boolean) {
      super(message)
    }
  }
  return { MockSendError }
})

vi.mock('../src/summarize.js', () => ({ summarize: vi.fn() }))
vi.mock('../src/telegram.js', () => ({
  formatPost: vi.fn(() => 'POST'),
  sendToChannel: vi.fn(),
  SendError: MockSendError,
}))

import { summarize } from '../src/summarize.js'
import { sendToChannel } from '../src/telegram.js'
import { publishPending, reconcilePosting } from '../src/poller.js'
import { resetDbForTest } from '../src/db.js'

const mockSummarize = vi.mocked(summarize)
const mockSend = vi.mocked(sendToChannel)

function insertPending(db: Database.Database, title: string, overrides: Record<string, unknown> = {}) {
  db.prepare(`INSERT INTO items
    (feed_url, category, source_name, url, url_hash, title, title_norm, published_at, fetched_at, status, summary_json)
    VALUES (@feed_url,@category,@source_name,@url,@url_hash,@title,@title_norm,@published_at,@fetched_at,@status,@summary_json)`).run({
    feed_url: 'https://f/feed', category: 'world', source_name: 'Reuters',
    url: 'https://f/' + title.replace(/\s+/g, '-'), url_hash: 'h_' + title,
    title, title_norm: title.toLowerCase(),
    published_at: Date.now() - 60_000, fetched_at: Date.now(),
    status: 'pending', summary_json: JSON.stringify({ excerpt: 'x' }),
    ...overrides,
  })
}

const okSummary = { titleZh: '东京大地震', summaryZh: '...', skip: false, importance: 5 }

beforeEach(() => vi.clearAllMocks())

describe('publishPending failure handling', () => {
  it('definite send failure → stays pending with backoff, posts after recovery (never silently dropped)', async () => {
    const db = resetDbForTest(':memory:')
    insertPending(db, 'Major Earthquake Hits Tokyo')
    mockSummarize.mockResolvedValue(okSummary)

    // TG outage: definite failure (maybeSent=false)
    mockSend.mockRejectedValue(new MockSendError('tg 502 exhausted', false))
    await publishPending(db)
    let row = db.prepare('SELECT * FROM items').get() as any
    expect(row.status).toBe('pending')
    expect(row.fail_count).toBe(1)
    expect(row.next_retry_at).toBeGreaterThan(Date.now())

    // immediate next cycle: backoff excludes it — no hammering
    await publishPending(db)
    expect(mockSend).toHaveBeenCalledTimes(1)

    // backoff elapses, TG recovers → the story IS posted
    db.prepare('UPDATE items SET next_retry_at = ?').run(Date.now() - 1000)
    mockSend.mockResolvedValue(12345)
    await publishPending(db)
    row = db.prepare('SELECT * FROM items').get() as any
    expect(row.status).toBe('posted')
    expect(row.posted_msg_id).toBe(12345)
  })

  it('ambiguous delivery (maybeSent) → marked posted, never re-sent (no duplicate post)', async () => {
    const db = resetDbForTest(':memory:')
    insertPending(db, 'Bank Run Spreads Across Europe')
    mockSummarize.mockResolvedValue(okSummary)
    mockSend.mockRejectedValue(new MockSendError('tg response unreadable (http 200)', true))

    await publishPending(db)
    const row = db.prepare('SELECT * FROM items').get() as any
    expect(row.status).toBe('posted')
    expect(JSON.parse(row.summary_json).deliveryUncertain).toBe(true)

    await publishPending(db)
    expect(mockSend).toHaveBeenCalledTimes(1)
  })

  it('LLM outage → backoff retries, then title-only fallback post instead of dropping the story', async () => {
    const db = resetDbForTest(':memory:')
    insertPending(db, 'Critical Zero-Day In OpenSSL')
    mockSummarize.mockRejectedValue(new Error('LLM 503'))
    mockSend.mockResolvedValue(777)

    // 4 failing attempts (fast-forwarding the backoff each time)
    for (let i = 0; i < 4; i++) {
      await publishPending(db)
      db.prepare('UPDATE items SET next_retry_at = ?').run(Date.now() - 1000)
    }
    let row = db.prepare('SELECT * FROM items').get() as any
    expect(row.status).toBe('pending')
    expect(row.fail_count).toBe(4)
    expect(mockSend).not.toHaveBeenCalled()

    // 5th attempt: fallback — post the raw title rather than lose the story
    await publishPending(db)
    row = db.prepare('SELECT * FROM items').get() as any
    expect(row.status).toBe('posted')
    expect(JSON.parse(row.summary_json).titleZh).toBe('Critical Zero-Day In OpenSSL')
  })

  it('stale pending items expire instead of flooding after an outage', async () => {
    const db = resetDbForTest(':memory:')
    insertPending(db, 'Old Story', {
      published_at: Date.now() - 30 * 3600 * 1000, fetched_at: Date.now() - 30 * 3600 * 1000,
    })
    insertPending(db, 'Dateless Old Story', {
      published_at: null, fetched_at: Date.now() - 30 * 3600 * 1000,
    })
    insertPending(db, 'Fresh Story')
    mockSummarize.mockResolvedValue(okSummary)
    mockSend.mockResolvedValue(1)

    await publishPending(db)
    const rows = db.prepare('SELECT title, status FROM items ORDER BY id').all() as any[]
    expect(rows[0].status).toBe('skipped')
    expect(rows[1].status).toBe('skipped') // dateless ages by fetched_at
    expect(rows[2].status).toBe('posted')
    expect(mockSend).toHaveBeenCalledTimes(1)
  })

  it('send success + bookkeeping DB failure → row stays posting, reconciled, NEVER re-sent', async () => {
    const db = resetDbForTest(':memory:')
    insertPending(db, 'Fed Cuts Rates')
    mockSummarize.mockResolvedValue(okSummary)
    mockSend.mockResolvedValue(555) // Telegram ACCEPTED the message

    // the success-bookkeeping UPDATE (the one writing posted_msg_id) throws
    const flaky = {
      prepare: (sql: string) => sql.includes('posted_msg_id')
        ? { run: () => { throw new Error('SQLITE_BUSY: database is locked') } }
        : db.prepare(sql),
    }
    await publishPending(flaky as never)
    let row = db.prepare('SELECT * FROM items').get() as any
    expect(row.status).toBe('posting') // NOT reverted to pending
    expect(mockSend).toHaveBeenCalledTimes(1)

    // next cycle: reconcile self-heals, item is never sent again
    reconcilePosting(db)
    await publishPending(db)
    row = db.prepare('SELECT * FROM items').get() as any
    expect(row.status).toBe('posted')
    expect(mockSend).toHaveBeenCalledTimes(1)
  })

  it('reconcilePosting marks crash-window rows posted (prefer missed over duplicate)', () => {
    const db = resetDbForTest(':memory:')
    insertPending(db, 'In Flight During Crash', { status: 'posting' })
    insertPending(db, 'Untouched')
    reconcilePosting(db)
    const rows = db.prepare('SELECT title, status FROM items ORDER BY id').all() as any[]
    expect(rows[0].status).toBe('posted')
    expect(rows[1].status).toBe('pending')
  })
})
