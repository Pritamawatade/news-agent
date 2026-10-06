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

---

## Setup (full walkthrough)

You need **4 secrets**: `GROQ_API_KEY`, `FIRECRAWL_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. Everything else has sane defaults. Total setup time: ~10 minutes. All providers have free tiers — no credit card required.

### Providers used

| Provider | Used for | Where to get the key | Free tier |
|---|---|---|---|
| **Groq** | LLM curation (`src/agent.ts` via `@ai-sdk/groq` + `ai` SDK) | https://console.groq.com → left sidebar **API Keys** → **Create API Key**, starts with `gsk_…` | 1,000 req/day, 200k tok/day, 30 req/min on `gpt-oss-20b` |
| **Firecrawl** (`@mendable/firecrawl-js` v4) | Web **search** + article **scrape** (`src/firecrawl.ts`) | https://firecrawl.dev → **Sign in** → Dashboard → **API Keys**, starts with `fc-…` | ~500 credits free (search ≈ 1 credit, scrape ≈ 1–2 credits) |
| **Telegram Bot API** | Digest delivery + `/whatsnew` commands (`src/telegram.ts`, `src/listener.ts`). No SDK — plain `fetch` to `api.telegram.org`. Free forever. | Telegram app → **@BotFather** (see step-by-step below) | Unlimited messages |

> `@ai-sdk/google` is listed in `package.json` but not used by default — ignore it unless you want to swap the curator model to Gemini later.

### 0. Prerequisites

```bash
# 1. Install Bun (package manager + runtime for this project)
curl -fsSL https://bun.sh/install | bash
bun --version

# 2. Clone + install deps
git clone <your-repo-url> news-agent
cd news-agent
bun install

# 3. Create your env file
cp .env.example .env
```

Bun auto-loads `.env` — no `dotenv` import needed.

### 1. Get a Groq API key (LLM)

1. Go to **https://console.groq.com/home** and sign in (Google/GitHub works).
2. Left sidebar → **API Keys** → **Create API Key** → give it any name (e.g. `news-agent`).
3. Copy the key — it starts with `gsk_…`. You only see it once.
4. Paste into `.env`:
   ```ini
   GROQ_API_KEY=gsk_...
   ```
5. The default model is `openai/gpt-oss-20b` (set via `NEWS_LLM_MODEL`). Reason: Llama models are Enterprise-only on new Groq keys as of late 2025 — `gpt-oss-20b` works on every free key. Leave the default unless you know your key has access to another model.

### 2. Get a Firecrawl API key (search + scrape)

1. Go to **https://firecrawl.dev** → **Start for free** / **Sign in** → open the **Dashboard**.
2. Go to **API Keys** (or **Settings → API Keys**) → **Create / Copy** key. It starts with `fc-…`.
3. Paste into `.env`:
   ```ini
   FIRECRAWL_API_KEY=fc-...
   ```
4. What it powers:
   - `searchAiNews()` — 3 queries per cycle (`QUERIES` in `src/firecrawl.ts`), `tbs=qdr:d2` = last 2 days only, `limit = NEWS_MAX_RESULTS`.
   - `scrapeContents()` — max **5 pages/cycle**, 4000 chars each, 2 s gap (free tier is ~10 req/min). Login-walled sites (`instagram/facebook/tiktok/linkedin/reddit`) are skipped automatically and fall back to the search snippet.
5. If you run out of free credits, either add billing or raise `NEWS_CHECK_INTERVAL_HOURS` / lower `NEWS_MAX_RESULTS` to slow consumption.

### 3. Set up the Telegram bot (step-by-step)

This is the part most people get stuck on, so here is every click:

**a) Create the bot with @BotFather**

1. Open **Telegram** (phone or desktop) and search for **`@BotFather`** (verified, blue check).
2. Send `/newbot`.
3. BotFather asks for a **display name** — this is the "share title" people see when you share/forward the bot (e.g. `AI News Agent`). You can use spaces and emoji. You can change it later with `/setname`.
4. BotFather asks for a **username** — must be globally unique and end in `bot` (e.g. `my_ai_news_42bot`). This becomes the link `t.me/my_ai_news_42bot`.
5. BotFather replies with your **bot token**, looking like:
   ```
   123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
   ```
   Paste it into `.env`:
   ```ini
   TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
   ```
   ⚠️ Treat the token like a password — anyone with it controls your bot. If it leaks, send `/revoke` to BotFather.

Optional BotFather polish (all via chat with `@BotFather`):
- `/setdescription` — short bio shown on the bot profile.
- `/setabouttext` — one-liner.
- `/setcommands` — register command hints so Telegram shows them in the menu:
  ```
  whatsnew - fetch fresh AI news right now
  start - show help
  ```

**b) Activate the bot (required!)**

1. Open your bot's link `t.me/<your_bot_username>` → press **Start**, or just send any message (e.g. `hi`).
2. Until you do this, Telegram blocks the bot from messaging you (`400 Bad Request: chat not found`).

**c) Get your Telegram Chat ID (`TELEGRAM_CHAT_ID`)**

The bot is **private** — `src/listener.ts` only answers the chat ID in your `.env` and replies `🔒 Sorry, this is a private bot.` to everyone else. So this must be *your* numeric ID (or your group's ID).

Pick **one** method:

| Method | Steps |
|---|---|
| **A. @userinfobot (easiest)** | Search `@userinfobot` → **Start** → it replies with `Your ID: 123456789`. Copy that number. |
| **B. getUpdates URL** | Message your bot first (step b), then open in a browser: `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` (replace `<YOUR_TOKEN>`). Look for `"chat":{"id":123456789,…}`. That number is your chat ID. |
| **C. Group chat** | Add your bot to the group → send `/start@<your_bot_username>` in the group → open the `getUpdates` URL above → the group's `chat.id` will be **negative** (e.g. `-123456789`). Use that negative number. Also send `/setprivacy` → **Disable** to BotFather if you want the bot to see group commands. |

Then in `.env`:
```ini
TELEGRAM_CHAT_ID=123456789
```

**d) Verify Telegram works**

```bash
bun run test-telegram
```

You should get `✅ AI News agent connected!` in Telegram within seconds. If not, see the Telegram rows in [Troubleshooting](#troubleshooting).

**e) How chatting with the bot works**

- `/whatsnew` (or plain `what's new`) — runs the full pipeline immediately and replies with a digest (only works while `bun run listen` is running).
- `/start` — help text (`HELP_TEXT` in `src/listener.ts`).
- Any other chat ID gets the "private bot" rejection — change `TELEGRAM_CHAT_ID` to move ownership.

### 4. Fill in `.env` (reference)

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

| Variable | Required | Default | What it does |
|---|---|---|---|
| `GROQ_API_KEY` | yes | — | LLM curation. From https://console.groq.com → API Keys |
| `FIRECRAWL_API_KEY` | yes | — | Search + scrape. From https://firecrawl.dev dashboard |
| `TELEGRAM_BOT_TOKEN` | yes (unless `--dry`) | — | From @BotFather → `/newbot`. Format `digits:alphanumeric` |
| `TELEGRAM_CHAT_ID` | yes (unless `--dry`) | — | Your numeric user ID (@userinfobot) or negative group ID |
| `NEWS_CHECK_INTERVAL_HOURS` | no | `6` | Used by `loop` / `listen` modes. Don't go below `2` on free tiers |
| `NEWS_MAX_RESULTS` | no | `8` | Firecrawl results per query (3 queries → up to 3×N candidates) |
| `NEWS_LLM_MODEL` | no | `openai/gpt-oss-20b` | Any Groq-supported model ID your key can access |
| `NEWS_DB_PATH` | no | `./news.db` | SQLite dedupe memory. Delete to resend everything |

### 5. Run it

```bash
bun run dry            # full pipeline, prints digest, sends nothing, DB untouched
bun run test-telegram  # sends "connected!" ping to your Telegram
bun run start          # single cycle, sends digest if there is news
bun run loop           # sends now, then repeats every NEWS_CHECK_INTERVAL_HOURS
bun run listen         # interval digest + /whatsnew on demand (use for cloud deploy)
bun run typecheck      # tsc --noEmit
```

`bun run .` also works (defaults to single cycle).

Order for first run:

```bash
bun run test-telegram  # 1. prove Telegram works
bun run dry            # 2. prove search+scrape+LLM works (no side effects)
bun run start          # 3. real send
bun run listen         # 4. leave running for auto-digest + /whatsnew
```

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
| `Telegram send failed: 400` / `chat not found` | You didn't message the bot first (step 3b), or wrong `TELEGRAM_CHAT_ID`. Redo step 3b–3c. Group IDs must be negative |
| `401 Unauthorized` (Telegram) | Bad `TELEGRAM_BOT_TOKEN` — re-copy from @BotFather, check for trailing spaces/newlines |
| Bot replies `🔒 Sorry, this is a private bot.` | You're messaging from a different Telegram account than `TELEGRAM_CHAT_ID`. Update the env var to the ID you're testing from |
| Same news repeating | `news.db` deleted? Don't delete it — it's the dedupe memory |
| Never any news | Queries too narrow or all filtered — run `bun run dry` to see counts at each stage |
| `test-telegram` works, `start` sends nothing | Normal — means no fresh authentic news this cycle |
| `getUpdates` returns `{"ok":true,"result":[]}` | No messages yet — send a message to your bot first, then refresh the URL |

## Extending

- More queries: edit `QUERIES` in `src/firecrawl.ts`.
- More sources: edit `TRUSTED_DOMAINS` in `src/firecrawl.ts`.
- Lower bar: change `authenticity >= 0.7` in `src/agent.ts`.
- Fresh start: `rm news.db` (resends everything next run).
- Production: run `bun run loop` under `systemd`/pm2/Docker instead of a laptop terminal.
