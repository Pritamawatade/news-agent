import { Database } from "bun:sqlite";

let db: Database | null = null;

export function getDb(path: string): Database {
  if (db) return db;
  db = new Database(path, { create: true });
  db.run(`
    CREATE TABLE IF NOT EXISTS seen_news (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      source TEXT,
      first_seen_at TEXT NOT NULL
    )
  `);
  return db;
}

function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 120);
}

export function newsId(url: string, title: string): string {
  const normalized = normalizeTitle(title);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(url.trim().toLowerCase() + "|" + normalized);
  return hasher.digest("hex").slice(0, 32);
}

export function isAlreadySeen(db: Database, id: string): boolean {
  const row = db.query("SELECT 1 FROM seen_news WHERE id = ?").get(id) as unknown;
  return row !== null;
}

export function markSeen(db: Database, id: string, url: string, title: string, source: string) {
  db.run("INSERT OR IGNORE INTO seen_news (id, url, title, source, first_seen_at) VALUES (?, ?, ?, ?, ?)", [
    id,
    url,
    title,
    source,
    new Date().toISOString(),
  ]);
}

/** Remove entries older than N days so DB doesn't grow forever */
export function pruneOld(db: Database, days = 30) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  db.run("DELETE FROM seen_news WHERE first_seen_at < ?", [cutoff]);
}

// --- Near-duplicate detection: same story, different outlet ---
// "Google unveils Gemini 4 Argon" (google blog) vs "Google releases Gemini 4
// Argon model" (bloomberg) have different URLs, so id-dedupe misses them.
// Jaccard similarity on keyword tokens catches them; numbers ($5B vs $3B)
// and org names keep genuinely different stories apart.
const STOPWORDS = new Set(
  "the a an of to in on for with and or vs versus new latest update launches launch released release report says said amid after from by as at big major".split(" ")
);

function titleTokens(t: string): Set<string> {
  return new Set(
    t.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w.length > 2 && !STOPWORDS.has(w))
  );
}

export function titleSimilarity(a: string, b: string): number {
  const A = titleTokens(a);
  const B = titleTokens(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter); // Jaccard
}

/** True if a same-story headline was already recorded (last 30 days). */
export function hasNearDuplicate(db: Database, title: string, threshold = 0.4): boolean {
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  const rows = db.query("SELECT title FROM seen_news WHERE first_seen_at > ?").all(cutoff) as { title: string }[];
  return rows.some((r) => titleSimilarity(r.title, title) >= threshold);
}
