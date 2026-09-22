# Contributing to tg-newsbot

## What it is

A Telegram channel news pusher. The pipeline is:

```
feeds.json → fetcher → dedupe → SQLite → summarize (local LLM) → publish
```

Understanding the pipeline matters more than any single file, so read the
README's `## 流程` block first.

## Setup

```bash
npm install
npm test                          # vitest run
npm run dry                       # DRY_RUN=1, one pass, nothing published
npm run dev                       # tsx src/index.ts
```

**Always test with `npm run dry` before running the real thing.** It does a
single pass with publishing disabled.

## Adding or fixing a feed

`feeds.json` holds ~40 sources across 6 categories, all manually verified for
reachability. When you add or change one:

- Set `intervalSec` deliberately. The default is 600s; the 60s ticker only
  picks up sources whose interval has elapsed. A tiny interval on a slow
  upstream will get you rate-limited.
- If the source needs a proxy, set it — `fetcher` honours a per-source SOCKS
  proxy.
- Verify the feed actually parses (RSS2 / Atom / RDF are all supported) and
  that inline images are extracted correctly.

## Changing dedupe or summarise

These are the parts most likely to regress silently:

- **dedupe** = URL canonical hash (strips `utm_*` etc.) **plus** cross-source
  title fuzzy match using CJK bigram Jaccard ≥ 0.6. Lowering the threshold
  merges distinct stories; raising it lets duplicates through.
- **summarise** hits a local OpenAI-compatible endpoint. The output is a
  Chinese title plus 2–3 sentences, with a `skip` verdict for junk and an
  importance score. If you change the prompt, keep the `skip` path intact —
  it's what keeps the channel readable.

## Database

`data/newsbot.db`. Sources are **silently seeded on first sight** — the bot
will not flood the channel with a feed's back catalogue when you add it. If you
change that behaviour, say so loudly in the PR; it's user-visible.

## Rules

- One logical change per PR.
- `npm test` passes, and you've done a `npm run dry` pass.
- Never commit API keys, real bot tokens, or `.env`.
- Don't reformat `feeds.json` wholesale — it makes the diff unreviewable.
