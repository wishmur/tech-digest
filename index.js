import Parser from "rss-parser";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// ============================ CONFIG ============================
const FEEDS = [
  { name: "TechCrunch AI",      url: "https://techcrunch.com/category/artificial-intelligence/feed/" },
  { name: "The Verge",          url: "https://www.theverge.com/rss/index.xml" },
  { name: "VentureBeat AI",     url: "https://venturebeat.com/category/ai/feed/" },
  { name: "AWS News",           url: "https://aws.amazon.com/blogs/aws/feed/" },
  { name: "NVIDIA Blog",        url: "https://blogs.nvidia.com/feed/" },
  { name: "Stratechery",        url: "https://stratechery.com/feed/" },
  { name: "Lenny's Newsletter", url: "https://www.lennysnewsletter.com/feed" },
  { name: "Hacker News",        url: "https://hnrss.org/frontpage" },
];

const PRIORITY = "AI products and models, NVIDIA, AWS, OpenAI, Anthropic, Google DeepMind, product management, AI tooling, and major funding or launches";
const KEYWORDS = ["ai","artificial intelligence","llm","model","gpt","claude","gemini","openai",
  "anthropic","nvidia","aws","amazon","google","meta","microsoft","product","launch","funding",
  "raise","acqui","agent","chip","gpu","startup","api","feature","robot","data"];
const TAG_VOCAB = "launch, funding, leadership, regulation, open-source, competitive, research, product, infra, tooling";

const LOOKBACK_HOURS = 36;
const MAX_TO_CLAUDE  = 40;
const TOP_N          = 10;
const MODEL          = "claude-sonnet-4-6";
const DATA_PATH      = "data/digest.json";
// ================================================================

const { ANTHROPIC_API_KEY } = process.env;
if (!ANTHROPIC_API_KEY) { console.error("Missing env var: ANTHROPIC_API_KEY"); process.exit(1); }

const parser = new Parser({ timeout: 15000 });
const shortHash = s => crypto.createHash("md5").update(String(s)).digest("hex").slice(0, 10);

async function fetchFeeds() {
  const all = [];
  for (const f of FEEDS) {
    try {
      const feed = await parser.parseURL(f.url);
      for (const it of feed.items || []) {
        all.push({
          title: (it.title || "").trim(),
          link: (it.link || "").trim(),
          source: f.name,
          date: it.isoDate || it.pubDate || null,
          snippet: (it.contentSnippet || it.summary || "").replace(/\s+/g, " ").trim().slice(0, 200),
        });
      }
      console.log(`ok:   ${f.name} (${(feed.items || []).length})`);
    } catch (e) {
      console.warn(`skip: ${f.name} -> ${e.message}`);
    }
  }
  return all;
}

const recent = items => {
  const cutoff = Date.now() - LOOKBACK_HOURS * 3600 * 1000;
  return items.filter(i => {
    if (!i.date) return true;
    const t = Date.parse(i.date);
    return isNaN(t) ? true : t >= cutoff;
  });
};

const dedupeByLink = items => {
  const seen = new Set(); const out = [];
  for (const i of items) { const k = i.link || i.title; if (!k || seen.has(k)) continue; seen.add(k); out.push(i); }
  return out;
};

const keywordFilter = items => {
  const kept = items.filter(i => {
    const hay = (i.title + " " + i.snippet).toLowerCase();
    return KEYWORDS.some(k => hay.includes(k));
  });
  return kept.length >= 15 ? kept : items;
};

async function curate(items) {
  const list = items.slice(0, MAX_TO_CLAUDE)
    .map((it, idx) => `${idx}. [${it.source}] ${it.title}${it.snippet ? ` - ${it.snippet}` : ""}`)
    .join("\n");

  const system =
    `You are a tech news curator for a product manager. From the numbered headlines, do two things:\n\n` +
    `1) Pick the ${TOP_N} most important stories for a PM to know today, prioritizing: ${PRIORITY}. ` +
    `For each pick: write one concise sentence on why it matters (no hype, no em dashes), name the primary company, ` +
    `list any secondary companies involved (array, can be empty), assign a short topic, give an importance score 1-5 ` +
    `(5 = must-read), and add 1-3 short tags chosen from: ${TAG_VOCAB}.\n\n` +
    `2) Write a 2-3 sentence "today's brief" summarizing the day's most material developments across your picks. ` +
    `Plain language. Lead with the biggest thing. No hype. No em dashes.\n\n` +
    `Skip low-signal, duplicate, or purely promotional items.\n\n` +
    `Output RAW JSON only. No markdown or commentary. Schema:\n` +
    `{\n  "summary": "",\n  "items": [{\n    "index": 0, "summary": "", "topic": "", "company": "",\n    "secondaryCompanies": [], "importance": 3, "tags": []\n  }]\n}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 2000, system, messages: [{ role: "user", content: `Headlines:\n${list}` }] }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);

  const data = await res.json();
  let txt = (data.content?.[0]?.text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const s = txt.indexOf("{"), e = txt.lastIndexOf("}");
  if (s !== -1 && e !== -1) txt = txt.slice(s, e + 1);

  let parsed;
  try { parsed = JSON.parse(txt); }
  catch (err) { throw new Error(`Curation JSON parse failed: ${err.message} | ${txt.slice(0, 300)}`); }

  const summary = (parsed.summary || "").trim();
  const picks = (parsed.items || []).map(p => {
    const it = items[p.index];
    if (!it) return null;
    return {
      id: shortHash(it.link || it.title),
      title: it.title,
      link: it.link,
      source: it.source,
      summary: p.summary || "",
      topic: p.topic || "",
      company: p.company || "",
      secondaryCompanies: Array.isArray(p.secondaryCompanies) ? p.secondaryCompanies : [],
      importance: Number.isFinite(p.importance) ? Math.max(1, Math.min(5, Math.round(p.importance))) : 3,
      tags: Array.isArray(p.tags) ? p.tags.slice(0, 4) : [],
      publishedAt: it.date || null,
    };
  }).filter(Boolean).slice(0, TOP_N);

  return { summary, picks };
}

async function loadDigest() {
  try {
    const raw = await fs.readFile(DATA_PATH, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === "ENOENT") return { lastUpdated: null, days: [] };
    throw e;
  }
}

async function saveDigest(digest) {
  await fs.mkdir(path.dirname(DATA_PATH), { recursive: true });
  await fs.writeFile(DATA_PATH, JSON.stringify(digest, null, 2) + "\n", "utf8");
}

async function main() {
  console.log("Fetching feeds...");
  let items = dedupeByLink(recent(await fetchFeeds()));
  console.log(`recent + deduped: ${items.length}`);
  items = keywordFilter(items);
  console.log(`after keyword filter: ${items.length}`);
  if (items.length === 0) { console.log("Nothing to curate today."); return; }

  // Cross-day dedupe: skip anything whose link is already anywhere in the file.
  const digest = await loadDigest();
  const seenLinks = new Set();
  for (const day of digest.days || []) for (const it of day.items || []) seenLinks.add(it.link);
  items = items.filter(i => !seenLinks.has(i.link));
  console.log(`after history dedupe: ${items.length}`);
  if (items.length === 0) { console.log("No new stories today, already covered."); return; }

  const { summary, picks } = await curate(items);
  console.log(`curated: ${picks.length}`);
  if (picks.length === 0) { console.log("No picks today."); return; }

  const today = new Date().toISOString().slice(0, 10);
  for (const p of picks) p.addedOn = today;

  const existingIdx = (digest.days || []).findIndex(d => d.date === today);
  if (existingIdx !== -1) {
    digest.days[existingIdx].items = [...digest.days[existingIdx].items, ...picks];
    digest.days[existingIdx].summary = summary;
  } else {
    digest.days = [{ date: today, summary, items: picks }, ...(digest.days || [])];
  }
  digest.lastUpdated = new Date().toISOString();

  await saveDigest(digest);
  console.log(`Wrote ${DATA_PATH}: +${picks.length} items today, ${digest.days.length} day(s) on file.`);
}

main().catch(e => { console.error(e); process.exit(1); });
