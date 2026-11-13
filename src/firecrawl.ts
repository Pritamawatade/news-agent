import Firecrawl from "@mendable/firecrawl-js";

export interface RawNews {
  url: string;
  title: string;
  snippet: string;
  source: string;
  publishedAt?: string;
}

// Broad authenticity filter layer 1 — LLM does layer 2 (content verification).
// Trusted = official AI labs / big tech + major tech press + business/VC press
// + social (X, etc.).
const TRUSTED_DOMAINS = [
  // AI labs & big tech (official blogs/newsrooms count as most authentic)
  "openai.com", "anthropic.com", "deepmind.google", "blog.google", "research.google",
  "about.google", "microsoft.com", "news.microsoft.com", "nvidia.com", "newsroom.ibm.com",
  "ibm.com", "meta.com", "amazon.science", "aws.amazon.com", "x.ai", "mistral.ai",
  "cohere.com", "stability.ai", "perplexity.ai", "together.ai", "fireworks.ai", "groq.com",
  "huggingface.co", "apple.com", "newsroom.intel.com", "samsung.com", "qualcomm.com",
  "arm.com", "broadcom.com", "oracle.com", "salesforce.com", "adobe.com",
  // Major tech & business press
  "techcrunch.com", "theverge.com", "wired.com", "bloomberg.com",
  "reuters.com", "ft.com", "axios.com", "venturebeat.com",
  "theinformation.com", "arstechnica.com", "siliconangle.com",
  "theguardian.com", "nytimes.com", "washingtonpost.com", "wsj.com",
  "cnbc.com", "forbes.com", "fortune.com", "economist.com", "bbc.com",
  "sifted.eu", "techinasia.com", "crunchbase.com", "pitchbook.com",
  "engadget.com", "cnet.com", "zdnet.com", "thenextweb.com", "techradar.com",
  "theregister.com", "gizmodo.com", "businessinsider.com", "protocol.com",
  "apnews.com", "marketwatch.com", "barrons.com", "seekingalpha.com",
  // Official press-release wires (hires, layoffs, M&A announcements)
  "prnewswire.com", "businesswire.com", "globenewswire.com",
  // Social / aggregators (Firecrawl often can't scrape these —
  // they flow through on search-snippet fallback instead)
  "x.com", "twitter.com", "reddit.com", "news.ycombinator.com", "linkedin.com",
];

// Firecrawl can't scrape these (login walls / unsupported) —
// don't waste scrape credits on them, use their search snippet instead.
const UNSCRAPABLE_DOMAINS = [
  "instagram.com", "facebook.com", "tiktok.com", "linkedin.com", "reddit.com",
];

export function isUnscrapable(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return UNSCRAPABLE_DOMAINS.some((d) => host === d || host.endsWith("." + d));
  } catch {
    return false;
  }
}

// Each query costs ~1 Firecrawl search credit per cycle, so keep the list tight
// but cover the whole tech-news surface: AI models, broader product launches,
// money (funding/IPO/M&A), people (CEO/hires/layoffs), research and data reports.
const QUERIES = [
  // AI model & major product launches
  "new AI model release announcement",
  "major tech product launch announcement",
  // Money: funding, IPOs, acquisitions, mergers
  "AI startup funding round IPO",
  "technology company acquisition merger deal",
  // People: leadership changes, major hires, layoffs
  "technology company CEO change new chief executive",
  "tech company executive hire layoffs job cuts",
  // Research, policy and industry facts & figures
  "major AI breakthrough research advancement",
  "tech industry report survey data statistics",
];

export function isTrusted(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return TRUSTED_DOMAINS.some((d) => host === d || host.endsWith("." + d));
  } catch {
    return false;
  }
}

export async function searchAiNews(apiKey: string, maxResults: number): Promise<RawNews[]> {
  const client = new Firecrawl({ apiKey });
  const all: RawNews[] = [];

  for (const query of QUERIES) {
    try {
      const res: any = await client.search(query, {
        limit: maxResults,
        tbs: "qdr:d2", // last 2 days only — avoids re-fetching stale news
      });
      // New SDK (v4) groups results by source: { web: [...], news: [...] }.
      // Do NOT touch res.data — the SDK throws on access (migration guard).
      const items = [...(res?.web ?? []), ...(res?.news ?? [])];
      for (const item of items) {
        if (!item?.url || !item?.title) continue;
        all.push({
          url: item.url,
          title: item.title,
          snippet: item.description ?? item.snippet ?? "",
          source: (() => {
            try { return new URL(item.url).hostname; } catch { return "unknown"; }
          })(),
        });
      }
    } catch (err) {
      console.error(`[firecrawl] search failed for "${query}":`, (err as Error).message);
    }
  }

  // Dedupe by URL, prefer trusted sources
  const byUrl = new Map<string, RawNews>();
  for (const n of all) {
    if (!byUrl.has(n.url)) byUrl.set(n.url, n);
  }
  return [...byUrl.values()]
    .sort((a, b) => Number(isTrusted(b.url)) - Number(isTrusted(a.url)))
    .slice(0, maxResults * 2);
}

/** Scrape full content for NEW urls only — caller must dedupe first to save tokens */
export async function scrapeContents(
  apiKey: string,
  urls: string[],
  maxChars = 4000
): Promise<Map<string, string>> {
  const client = new Firecrawl({ apiKey });
  const out = new Map<string, string>();
  // Cap scrapes per run — biggest cost saver. Skip login-walled sites (snippet fallback covers them).
  // Small delay between scrapes: Firecrawl free tier is ~10 req/min shared with search.
  const scrapable = urls.filter((u) => !isUnscrapable(u)).slice(0, 5);
  for (const url of scrapable) {
    try {
      const doc: any = await client.scrape(url, { formats: ["markdown"] });
      const md: string = doc?.markdown ?? doc?.data?.markdown ?? "";
      if (md.length > 200) out.set(url, md.slice(0, maxChars));
    } catch (err) {
      console.error(`[firecrawl] scrape failed ${url}:`, (err as Error).message);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return out;
}
