import { generateObject } from "ai";
import { groq } from "@ai-sdk/groq";
import { z } from "zod";
import type { RawNews } from "./firecrawl.ts";

const NewsItem = z.object({
  url: z.string(),
  headline: z.string(),
  summary: z.string().max(400),
  category: z.enum([
    "model_launch",
    "product_launch",
    "funding_ipo",
    "acquisition_merger",
    "leadership_change",
    "hiring_layoffs",
    "breakthrough",
    "industry_report",
    "other_major",
  ]),
  authenticity: z.number().min(0).max(1),
});

const AgentOutput = z.object({ news: z.array(NewsItem).max(10) });

export interface CuratedNews {
  url: string;
  headline: string;
  summary: string;
  category: string;
  authenticity: number;
}

/**
 * SINGLE batched LLM call per run — not one call per article.
 * Filters hype/rumors, keeps only major tech/AI news, writes Telegram-ready summaries.
 */
export async function curateWithAgent(
  model: string,
  items: { news: RawNews; content: string }[]
): Promise<CuratedNews[]> {
  if (items.length === 0) return [];

  // Keep each item short: free-tier TPM cap is 8000, so the whole batch must stay ~6k tokens.
  const batch = items
    .slice(0, 8)
    .map((it, i) => `[${i}] URL: ${it.news.url}\nTitle: ${it.news.title}\nSnippet: ${it.news.snippet.slice(0, 300)}\nContent: ${it.content.slice(0, 800)}`)
    .join("\n\n---\n\n");

  const { object } = await generateObject({
    model: groq(model),
    schema: AgentOutput,
    prompt: `You are a technology-news editor. From the candidates below, keep ONLY major, authentic tech/AI news:
- AI model launches and major product launches (OpenAI, Anthropic, Google, Meta, xAI, DeepSeek, Qwen, Apple, Microsoft, Nvidia, etc.)
- funding rounds, IPOs, acquisitions and mergers
- CEO/executive changes, major hires and layoffs
- major technical breakthroughs, policy shifts and industry reports with concrete facts and figures

REJECT: rumors without named source, opinion pieces, tutorials, minor updates, duplicates, SEO spam.
Score authenticity 0-1 (source reputation + concrete facts + dates/numbers). Drop anything < 0.7.
Write a 1-2 sentence neutral summary each. Max 8 items, most important first.
Pick the best-fitting category for each item from the schema.

Candidates:\n${batch}`,
  });

  return object.news.filter((n) => n.authenticity >= 0.7);
}
