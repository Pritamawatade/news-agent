export const config = {
  groqApiKey: process.env.GROQ_API_KEY ?? "",
  firecrawlApiKey: process.env.FIRECRAWL_API_KEY ?? "",
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID ?? "",
  // Optimization: how often to run. Default 6h. Don't set below 2h or you'll burn quota.
  intervalHours: Number(process.env.NEWS_CHECK_INTERVAL_HOURS ?? "6"),
  // Max Firecrawl search results per query (keeps token/API cost low)
  maxResultsPerQuery: Number(process.env.NEWS_MAX_RESULTS ?? "8"),
  // LLM model: 20b is 2x faster + 2x cheaper than 120b, good enough for filtering
  llmModel: process.env.NEWS_LLM_MODEL ?? "openai/gpt-oss-20b",
  dbPath: process.env.NEWS_DB_PATH ?? "./news.db",
};

export function assertConfig(runTelegram: boolean) {
  const missing: string[] = [];
  if (!config.groqApiKey) missing.push("GROQ_API_KEY");
  if (!config.firecrawlApiKey) missing.push("FIRECRAWL_API_KEY");
  if (runTelegram) {
    if (!config.telegramBotToken) missing.push("TELEGRAM_BOT_TOKEN");
    if (!config.telegramChatId) missing.push("TELEGRAM_CHAT_ID");
  }
  if (missing.length > 0) {
    throw new Error(`Missing env: ${missing.join(", ")}. Copy .env.example to .env and fill them.`);
  }
}
