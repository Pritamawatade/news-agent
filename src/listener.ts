const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Long-poll Telegram Bot API for incoming commands.
 * Only the owner chat (TELEGRAM_CHAT_ID) can trigger workflows;
 * anyone else gets a polite "private bot" reply.
 */
export async function listenForCommands(
  botToken: string,
  ownerChatId: string,
  onCommand: (chatId: string, cmd: "whatsnew" | "start") => Promise<void>
) {
  // Skip stale messages from before boot so we don't replay old commands.
  let offset = 0;
  try {
    const init = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates?timeout=5`);
    const data: any = await init.json();
    const ids = (data.result ?? []).map((u: any) => u.update_id);
    if (ids.length > 0) offset = Math.max(...ids) + 1;
  } catch {
    // non-fatal — polling loop will pick up from 0
  }

  console.log("[tg] listening — send /whatsnew or /start to the bot.");
  while (true) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates?timeout=30&offset=${offset}`);
      if (!res.ok) {
        console.error(`[tg] getUpdates ${res.status}, retrying...`);
        await sleep(5000);
        continue;
      }
      const data: any = await res.json();
      for (const u of data.result ?? []) {
        offset = u.update_id + 1;
        const text: string | undefined = u.message?.text;
        const chatId = u.message?.chat?.id != null ? String(u.message.chat.id) : null;
        if (!text || !chatId) continue;
        const cmd = text.trim().toLowerCase();
        if (cmd.startsWith("/whatsnew") || cmd === "what's new" || cmd === "whatsnew") {
          await onCommand(chatId, "whatsnew");
        } else if (cmd.startsWith("/start") || cmd.startsWith("/help")) {
          await onCommand(chatId, "start");
        } else if (chatId === ownerChatId && cmd.startsWith("/")) {
          await onCommand(chatId, "start"); // unknown command → help
        }
        // messages from other chats that aren't commands are ignored silently
      }
    } catch (err) {
      console.error("[tg] poll error:", (err as Error).message);
      await sleep(5000);
    }
  }
}

export const HELP_TEXT =
  "🤖 <b>AI News Agent</b>\n\n" +
  "/whatsnew — fetch fresh AI news right now\n" +
  `Plus an automatic digest every ${process.env.NEWS_CHECK_INTERVAL_HOURS ?? "6"}h.\n\n` +
  "I track model launches, funding/IPOs and breakthroughs — " +
  "deduplicated and authenticity-scored before anything reaches you.";
