import { config, assertConfig } from "./src/config.ts";
import { getDb, newsId, isAlreadySeen, markSeen, pruneOld, hasNearDuplicate, titleSimilarity } from "./src/db.ts";
import { searchAiNews, scrapeContents, isTrusted } from "./src/firecrawl.ts";
import { curateWithAgent } from "./src/agent.ts";
import { formatDigest, sendTelegram } from "./src/telegram.ts";
import { listenForCommands, HELP_TEXT } from "./src/listener.ts";

const mode = process.argv[2] ?? "once"; // once | loop | listen | test-telegram

async function runCycle(sendToTelegram: boolean, targetChatId = config.telegramChatId) {
  assertConfig(sendToTelegram);
  const db = getDb(config.dbPath);

  console.log("[news] searching via Firecrawl...");
  const found = await searchAiNews(config.firecrawlApiKey, config.maxResultsPerQuery);
  console.log(`[news] found ${found.length} candidates`);

  // DEDUPE LAYER 1 — exact URL+title, BEFORE scrape/LLM. The main token saver.
  const fresh = found.filter((n) => !isAlreadySeen(db, newsId(n.url, n.title)));

  // DEDUPE LAYER 2 — same story, different outlet ("Gemini 4 launch" on Google
  // blog vs on Bloomberg). Jaccard on headline keywords, vs DB + within batch.
  const unique: typeof fresh = [];
  let nearDupes = 0;
  for (const n of fresh) {
    if (
      hasNearDuplicate(db, n.title) ||
      unique.some((u) => titleSimilarity(u.title, n.title) >= 0.4)
    ) {
      nearDupes++;
      continue;
    }
    unique.push(n);
  }
  console.log(`[news] ${unique.length} new (${fresh.length - unique.length} exact dupes, ${nearDupes} same-story dupes skipped)`);

  if (unique.length === 0) {
    console.log("[news] nothing new. Skipping LLM + Telegram.");
    if (sendToTelegram) {
      for (const f of fresh) markSeen(db, newsId(f.url, f.title), f.url, f.title, f.source);
      pruneOld(db);
    }
    return;
  }

  const contents = await scrapeContents(config.firecrawlApiKey, unique.map((f) => f.url));
  // Prefer full scraped content; fall back to search snippet for trusted sources
  // (covers X/Twitter and other sites Firecrawl can't scrape).
  const withContent = unique
    .map((f) => {
      const scraped = contents.get(f.url);
      const fallback =
        !scraped && isTrusted(f.url) && f.snippet.length > 60 ? f.snippet : "";
      const content = scraped ?? fallback;
      return { news: f, content };
    })
    .filter((it) => it.content.length > 60)
    .slice(0, 8); // cap LLM input size per cycle (free-tier TPM is 8000)
  console.log(`[news] scraped ${withContent.length} pages`);

  if (withContent.length === 0) return;

  // ONE batched LLM call for the whole cycle
  const curated = await curateWithAgent(config.llmModel, withContent);
  console.log(`[news] curated ${curated.length} authentic items`);

  if (curated.length === 0) {
    console.log("[news] nothing passed authenticity filter. Not sending.");
    if (sendToTelegram) {
      // Real run: remember rejects so junk never loops. Dry run: touch nothing.
      for (const f of fresh) markSeen(db, newsId(f.url, f.title), f.url, f.title, f.source);
      pruneOld(db);
    }
    return;
  }

  const msg = formatDigest(curated);
  if (sendToTelegram) {
    await sendTelegram(config.telegramBotToken, targetChatId, msg);
    console.log("[news] 📩 digest sent to Telegram");
    // Mark seen ONLY after real send — dry runs must not consume the cache.
    for (const f of fresh) markSeen(db, newsId(f.url, f.title), f.url, f.title, f.source);
    pruneOld(db);
  } else {
    console.log("---- DIGEST (dry run, not sent) ----\n" + msg.replace(/<[^>]+>/g, ""));
    console.log("[news] dry run: DB untouched, re-run will show same news.");
  }
}

if (mode === "test-telegram") {
  assertConfig(true);
  await sendTelegram(config.telegramBotToken, config.telegramChatId, "✅ <b>AI News agent connected!</b> Send /whatsnew anytime, or wait for the auto-digest.");
  console.log("Test message sent.");
} else if (mode === "loop") {
  console.log(`[news] loop mode: every ${config.intervalHours}h. Ctrl+C to stop.`);
  await runCycle(true);
  setInterval(() => runCycle(true).catch((e) => console.error("[news] cycle error:", e.message)),
    config.intervalHours * 3600_000);
} else if (mode === "listen") {
  // Cloud mode: auto-digest on interval + on-demand /whatsnew. Deploy this.
  assertConfig(true);
  console.log(`[news] listen mode: auto-digest every ${config.intervalHours}h + Telegram commands. Ctrl+C to stop.`);
  setInterval(() => runCycle(true).catch((e) => console.error("[news] cycle error:", e.message)),
    config.intervalHours * 3600_000);
  await listenForCommands(config.telegramBotToken, config.telegramChatId, async (chatId, cmd) => {
    if (chatId !== config.telegramChatId) {
      await sendTelegram(config.telegramBotToken, chatId, "🔒 Sorry, this is a private bot.");
      return;
    }
    if (cmd === "start") {
      await sendTelegram(config.telegramBotToken, chatId, HELP_TEXT);
    } else {
      await sendTelegram(config.telegramBotToken, chatId, "🔍 <b>Fetching fresh AI news…</b> give me a minute.");
      await runCycle(true, chatId).catch(async (e) => {
        await sendTelegram(config.telegramBotToken, chatId, `⚠️ Fetch failed: ${e.message}. Try again later.`);
      });
    }
  });
} else {
  const dry = process.argv.includes("--dry");
  await runCycle(!dry);
}
