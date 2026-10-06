import type { CuratedNews } from "./agent.ts";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatDigest(items: CuratedNews[]): string {
  const date = new Date().toISOString().slice(0, 10);
  const lines = [`<b>🤖 AI News Digest — ${date}</b>`, ""];
  const emoji: Record<string, string> = {
    model_launch: "🚀",
    funding_ipo: "💰",
    breakthrough: "🔬",
    other_major: "📰",
  };
  items.forEach((n, i) => {
    const score = Math.round(n.authenticity * 10);
    lines.push(`${emoji[n.category] ?? "📰"} <b>${i + 1}. ${escapeHtml(n.headline)}</b>  ⭐${score}/10`);
    lines.push(`${escapeHtml(n.summary)}`);
    lines.push(`<a href="${n.url}">Read more</a>`);
    lines.push("");
  });
  return lines.join("\n").slice(0, 4000); // Telegram limit 4096
}

export async function sendTelegram(botToken: string, chatId: string, html: string) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: "HTML", disable_web_page_preview: false }),
  });
  if (!res.ok) throw new Error(`Telegram send failed: ${res.status} ${await res.text()}`);
}
