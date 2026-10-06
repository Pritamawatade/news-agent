# 🤖 AI News Agent — Groq + Firecrawl + Telegram

Multi-agent digest bot that fetches **major AI news only** (big model launches, IPO / funding, breakthroughs), **verifies authenticity**, and sends **one scored Telegram digest per cycle** — plus on-demand `/whatsnew`. LLM, scraping and hosting all on free tiers.

## Agents

| Agent | Job | Powered by |
|---|---|---|
| **Fetcher** | Firecrawl search (3 queries, recent window only) | Firecrawl free tier |
| **Verifier** | Trusted-domain check + single batched LLM judge, authenticity score 0–10, shown as ⭐/10 | Groq `gpt-oss-20b` free tier |
| **Dedupe memory** | Exact URL match + same-story detection across outlets (SQLite) | `bun:sqlite`, zero API cost |
| **Sender** | One digest message per cycle + `/whatsnew` on-demand replies | Telegram Bot API (free) |

## Architecture

```
                  ┌──────────────┐
                  │  index.ts    │  modes: once | loop | listen | test-telegram
                  │  (orchestr.) │
                  └──────┬───────┘
                         │ 1. search
              ┌──────────▼──────────┐
              │ src/firecrawl.ts    │  3 queries, last-2-days only (tbs=qdr:d2)
              │ Firecrawl search    │  trusted domains sorted first
              └──────────┬──────────┘
                         │ 2a. exact dedupe (URL hash)  2b. same-story dedupe
                         │     (Jaccard on headline keywords — catches
                         │     "Gemini 4 launch" on Google blog vs Bloomberg)
              ┌──────────▼──────────┐
              │ src/db.ts           │  bun:sqlite news.db
              │ exact + near-dupe   │  same news never processed twice
              └──────────┬──────────┘
                         │ 3. scrape new URLs only (max 5, 4k chars, 2s gaps)
                         │    + snippet fallback for X/Reddit/etc.
              ┌──────────▼──────────┐
              │ src/firecrawl.ts    │
              │ scrapeContents()    │
              └──────────┬──────────┘
                         │ 4. ONE batched LLM call (≤8 items, 800 chars each)
              ┌──────────▼──────────┐
              │ src/agent.ts        │  groq gpt-oss-20b + zod schema
              │ verifier agent      │  filter hype, authenticity ≥0.7 → ⭐/10
              └──────────┬──────────┘
                         │ 5. single scored digest
              ┌──────────▼──────────┐
              │ src/telegram.ts     │  Bot API sendMessage (HTML)
              │ format + send       │  + src/listener.ts: /whatsnew on demand
              └─────────────────────┘
```

### File map

| File | Role |
|---|---|
| `index.ts` | Entry. Modes: `once` (default, sends), `--dry` (prints, no send, DB untouched), `loop` (repeat every N hours), `listen` (interval digest + `/whatsnew` commands — deploy this), `test-telegram` (ping) |
| `src/config.ts` | Env loading + validation. Fails fast on missing keys |
| `src/firecrawl.ts` | Search (3 queries), ~40 trusted domains, unscrapable skip-list, capped scraping with rate-limit gaps |
| `src/db.ts` | SQLite dedupe: exact `SHA256(url+title)` + same-story Jaccard (≥0.4) vs last 30 days, 30-day prune |
| `src/agent.ts` | Single `generateObject` call: filter + categorize + summarize + authenticity score |
| `src/telegram.ts` | HTML digest with ⭐x/10 scores (4096-char safe) + sender |
| `src/listener.ts` | Long-poll `getUpdates`: `/whatsnew` → full workflow on demand, `/start` → help, non-owner chats rejected |
| `.env.example` | Template for required keys |
| `news.db` | Local state (delete to resend everything) |

### Data flow per cycle

1. **Search** — 3 Firecrawl queries (`model release`, `IPO/funding`, `breakthrough`), `limit=NEWS_MAX_RESULTS`, recency `qdr:d2`.
2. **Dedupe** — `newsId = sha256(url + normalizedTitle)`. If seen → skip. This runs *before* scraping/LLM, so repeats cost zero tokens.
3. **Scrape** — only fresh URLs, max 10 pages, truncated to 4000 chars. Unscrapable URLs are dropped.
4. **Curate (1 LLM call)** — whole batch in one `groq(openai/gpt-oss-20b)` structured-output call. Keeps ≤8 items, categories `model_launch | funding_ipo | breakthrough | other_major`, drops `authenticity < 0.7`.
5. **Send / skip** — all processed URLs marked seen (even rejects, so they're never retried). If curated list is empty → no Telegram message. Else one digest.

### Authenticity (2 layers)

- **Layer 1 — allowlist:** `openai.com, anthropic.com, deepmind.google, microsoft.com, nvidia.com, meta.com, x.ai, techcrunch.com, theverge.com, reuters.com, bloomberg.com, …` (see `src/firecrawl.ts`). Untrusted hits rank lower and rarely survive the LLM filter.
- **Layer 2 — LLM judge:** requires concrete facts (named org, numbers, dates), rejects rumors/tutorials/opinion/SEO spam, scores 0–1.

### Cost optimization (why it won't burn quota)

| Knob | Default | Effect |
|---|---|---|
| `NEWS_CHECK_INTERVAL_HOURS` | `6` (4 runs/day) | Never poll per-second/minute |
| `NEWS_MAX_RESULTS` | `8` | 3×8 searches max per cycle |
| Scrape cap | 10 pages × 4k chars | Hard ceiling in code |
| LLM calls | **1 per cycle** | Batched, not per-article |
| Model | `openai/gpt-oss-20b` | ~1000 tok/s, 2× cheaper than 120b |
| Telegram | 1 message/cycle, only if news | No spam |
| Free-tier fit | ~4 cycles/day × ~1k tokens | Well under Groq 1k req/day + 200k tok/day |

## Setup

### 1. Keys

| Key | Where |
|---|---|
| `GROQ_API_KEY` (`gsk_…`) | https://console.groq.com/home → API Keys |
| `FIRECRAWL_API_KEY` (`fc-…`) | https://firecrawl.dev → API Keys |
| `TELEGRAM_BOT_TOKEN` | Telegram → @BotFather → `/newbot` → message the new bot once |
| `TELEGRAM_CHAT_ID` | Telegram → @userinfobot (numeric ID), or `https://api.telegram.org/bot<TOKEN>/getUpdates` after messaging your bot |

### 2. Install + env

```bash
bun install
cp .env.example .env   # then fill in the 4 keys
```

`.env` (Bun auto-loads it, no dotenv import needed):

```ini
GROQ_API_KEY=gsk_...
FIRECRAWL_API_KEY=fc-...
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_CHAT_ID=123456789

NEWS_CHECK_INTERVAL_HOURS=6
NEWS_MAX_RESULTS=8
NEWS_LLM_MODEL=openai/gpt-oss-20b
NEWS_DB_PATH=./news.db
```

### 3. Scripts

```bash
bun run dry            # full pipeline, prints digest, sends nothing, DB untouched
bun run test-telegram  # sends "connected!" ping to your Telegram
bun run start          # single cycle, sends digest if there is news
bun run loop           # sends now, then repeats every NEWS_CHECK_INTERVAL_HOURS
bun run listen         # interval digest + /whatsnew on demand (use for cloud deploy)
bun run typecheck      # tsc --noEmit
```

`bun run .` also works (defaults to single cycle).

On Telegram, message your bot:
- `/whatsnew` (or plain `what's new`) — runs the full fetch → verify → digest workflow immediately (requires `listen` mode running)
- `/start` — help text

## Deploy free (runs 24/7)

`listen` mode is a single long-lived process — it fits any free host:

- **Railway / Render / Fly.io free tier:** connect the repo, set build `bun install`, start `bun run listen`, paste the 4 env vars from `.env`. Attach a tiny volume (or just let `news.db` rebuild — worst case one repeat digest).
- Any always-on machine / Raspberry Pi: `nohup bun run listen &` or a `systemd` unit.

No webhooks, no open ports — Telegram long-polling is outbound HTTPS only.

## Groq free-tier limits (Oct 2026)

`gpt-oss-20b/120b`: **30 req/min, 1,000 req/day, 8k tok/min, 200k tok/day** per org. This agent uses ~4 LLM calls/day → safe. Llama models are Enterprise-only on new keys — that's why this repo uses `openai/gpt-oss-20b`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Missing env: …` | `.env` incomplete — compare with `.env.example` |
| `model_not_found` from Groq | Key lacks model access — run `NEWS_LLM_MODEL=openai/gpt-oss-20b` (default) |
| `429 Too Many Requests` | Hit Groq/Firecrawl quota — raise interval, lower `NEWS_MAX_RESULTS` |
| `Telegram send failed: 400` | Wrong `TELEGRAM_CHAT_ID` (must message the bot first) or token typo |
| `401 Unauthorized` (Telegram) | Bad `TELEGRAM_BOT_TOKEN` |
| Same news repeating | `news.db` deleted? Don't delete it — it's the dedupe memory |
| Never any news | Queries too narrow or all filtered — run `bun run dry` to see counts at each stage |
| `test-telegram` works, `start` sends nothing | Normal — means no fresh authentic news this cycle |

## Extending

- More queries: edit `QUERIES` in `src/firecrawl.ts`.
- More sources: edit `TRUSTED_DOMAINS` in `src/firecrawl.ts`.
- Lower bar: change `authenticity >= 0.7` in `src/agent.ts`.
- Fresh start: `rm news.db` (resends everything next run).
- Production: run `bun run loop` under `systemd`/pm2/Docker instead of a laptop terminal.
