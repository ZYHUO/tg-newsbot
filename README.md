# tg-newsbot

Telegram 频道实时新闻推送：轮询 RSS/Atom 源 → 去重 → LLM 中文摘要 → 推送频道。

## 流程

```
feeds.json (6 大类 ~40 源，已实测可用性)
   │  每 60s 检查到期源（每源独立 intervalSec，默认 600s）
   ▼
fetcher  curl 抓取（按源走 SOCKS 代理）→ 解析 RSS2/Atom/RDF
   ▼
dedupe   URL 规范化哈希（去 utm 等）+ 跨源标题模糊去重（CJK bigram jaccard ≥0.6）
   ▼
SQLite   data/newsbot.db；首次见到的源静默播种（seeded），不发历史文章
   ▼
summarize 本机 LLM（OpenAI 兼容端点）→ 中文标题+2-3 句摘要 + 垃圾过滤(skip) + 重要度
   ▼
telegram  HTML 消息，4s 限速 + 429 退避；importance≥5 加 ⚡
```

## 运维

```bash
npm run dry        # 干跑一轮（不发消息，LLM 真实调用）
npm run build      # tsup → dist/
sudo systemctl restart tg-newsbot
journalctl -u tg-newsbot -f
```

## 配置

- `.env` — BOT_TOKEN / CHANNEL_ID / LLM_* / SOCKS_PROXY，见 `.env.example`
- `feeds.json` — 源列表；`disabled: true` 的是高流量备选源，按需打开；
  `needsProxy: true` 走 SOCKS；`intervalSec` 覆盖全局轮询间隔
- 改完配置 `systemctl restart` 生效；新加的源第一轮自动播种不刷屏

## 状态查询

```bash
node -e "const db=require('better-sqlite3')('data/newsbot.db');console.log(db.prepare('SELECT status,COUNT(*) n FROM items GROUP BY status').all())"
```

item status: `seeded` 播种(不发) / `pending` 待发 / `posted` 已发 / `skipped` 重复或广告 / `failed` 重试 3 次失败
