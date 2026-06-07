import { readFileSync } from 'node:fs'
import { config, validateConfig, type FeedConfig } from './config.js'
import { getDb } from './db.js'
import { runCycle, reconcilePosting } from './poller.js'

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a)

function loadFeeds(): FeedConfig[] {
  const feeds = JSON.parse(readFileSync(config.feedsPath, 'utf8')) as FeedConfig[]
  const bad = feeds.filter(f => !f.url || !f.category || !f.name)
  if (bad.length) throw new Error(`feeds.json: ${bad.length} entries missing url/category/name`)
  return feeds
}

async function main() {
  validateConfig()
  const feeds = loadFeeds()
  const db = getDb()
  reconcilePosting(db)
  const once = process.argv.includes('--once')
  log(`tg-newsbot starting: ${feeds.filter(f => !f.disabled).length} feeds, ` +
    `poll every ${config.pollIntervalSec}s, dryRun=${config.dryRun}, once=${once}`)

  // serialize cycles: a slow cycle must not overlap the next tick
  let running = false
  let stopping = false
  const tick = async () => {
    if (running || stopping) return
    running = true
    try {
      await runCycle(db, feeds)
    } catch (err) {
      log('cycle error:', (err as Error).stack ?? err)
    } finally {
      running = false
    }
  }

  await tick()
  if (once) { log('--once done'); return }

  // check every 60s which feeds are due (per-feed intervals are enforced inside runCycle)
  const timer = setInterval(tick, 60_000)

  // graceful shutdown: let an in-flight cycle finish its current DB commit
  // so we never die between "Telegram accepted" and "status=posted"
  const shutdown = (sig: string) => {
    if (stopping) return
    stopping = true
    log(`${sig} received, waiting for current cycle to finish…`)
    clearInterval(timer)
    const t0 = Date.now()
    const waiter = setInterval(() => {
      if (!running || Date.now() - t0 > 30_000) {
        clearInterval(waiter)
        db.close()
        log('shut down cleanly')
        process.exit(0)
      }
    }, 250)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch(err => {
  console.error('fatal:', err)
  process.exit(1)
})
