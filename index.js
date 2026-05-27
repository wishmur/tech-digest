import Parser from "rss-parser";
import crypto from "node:crypto";
import { connect } from "framer-api";

// ============================ CONFIG ============================
// Feeds are wrapped in try/catch individually, so a dead feed just gets
// skipped instead of breaking the run. Add or remove freely.
const FEEDS = [
  { name: "TechCrunch AI",     url: "https://techcrunch.com/category/artificial-intelligence/feed/" },
  { name: "The Verge",         url: "https://www.theverge.com/rss/index.xml" },
  { name: "VentureBeat AI",    url: "https://venturebeat.com/category/ai/feed/" },
  { name: "AWS News",          url: "https://aws.amazon.com/blogs/aws/feed/" },
  { name: "NVIDIA Blog",       url: "https://blogs.nvidia.com/feed/" },
  { name: "Stratechery",       url: "https://stratechery.com/feed/" },         // mostly paywalled, occasional free piece
  { name: "Lenny's Newsletter",url: "https://www.lennysnewsletter.com/feed" }, // weekly, free posts only
  { name: "Hacker News",       url: "https://hnrss.org/frontpage" },
];

// Curation steering for the PM angle.
const PRIORITY = "AI products and models, NVIDIA, AWS, OpenAI, Anthropic, Google DeepMind, product management, AI tooling, and major funding or launches";
// Cheap pre-filter (no tokens) to drop obvious noise before Claude sees anything.
const KEYWORDS = ["ai","artificial intelligence","llm","model","gpt","claude","gemini","openai",
  "anthropic","nvidia","aws","amazon","google","meta","microsoft","product","launch","funding",
  "raise","acqui","agent","chip","gpu","startup","api","feature","robot","data"];

const LOOKBACK_HOURS = 36;   // how far back counts as "today's" news
const MAX_TO_CLAUDE  = 40;   // cap items sent to the model (token economy)
const TOP_N          = 10;   // items published per day
const MODEL          = "claude-sonnet-4-6";   // swap to claude-haiku-4-5 to cut cost further
const COLLECTION_NAME = "AI Digest";
// ================================================================

const { ANTHROPIC_API_KEY, FRAMER_API_KEY, FRAMER_PROJECT_URL } = process.env;
function need(name, v) { if (!v) { console.error(`Missing env var: ${name}`); process.exit(1); } }
need("ANTHROPIC_API_KEY", ANTHROPIC_API_KEY);
need("FRAMER_API_KEY", FRAMER_API_KEY);
need("FRAMER_PROJECT_URL", FRAMER_PROJECT_URL);

const parser = new Parser({ timeout: 15000 });
const slugify = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "item";
const shortHash = s => crypto.createHash("md5").update(String(s)).digest("hex").slice(0, 8);

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

const dedupe = items => {
  const seen = new Set(); const out = [];
  for (const i of items) { const k = i.link || i.title; if (!k || seen.has(k)) continue; seen.add(k); out.push(i); }
  return out;
};

const keywordFilter = items => {
  const kept = items.filter(i => {
    const hay = (i.title + " " + i.snippet).toLowerCase();
    return KEYWORDS.some(k => hay.includes(k));
  });
  return kept.length >= 15 ? kept : items; // fall back on slow days so we never blank out
};

async function curate(items) {
  const list = items.slice(0, MAX_TO_CLAUDE)
    .map((it, idx) => `${idx}. [${it.source}] ${it.title}${it.snippet ? ` — ${it.snippet}` : ""}`)
    .join("\n");

  const system =
    `You are a tech news curator for a product manager. From the numbered headlines, pick the ${TOP_N} ` +
    `most important for a PM to know today, prioritizing: ${PRIORITY}. For each pick, write one concise ` +
    `sentence on why it matters (no hype, no em dashes), and tag a short topic and the main company. ` +
    `Skip low-signal, duplicate, or purely promotional items. Output RAW JSON only, no markdown or commentary, ` +
    `as an array of up to ${TOP_N} objects in priority order: ` +
    `[{"index": <number from the list>, "summary": "", "topic": "", "company": ""}]`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 1500, system, messages: [{ role: "user", content: `Headlines:\n${list}` }] }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);

  const data = await res.json();
  let txt = (data.content?.[0]?.text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  const s = txt.indexOf("["), e = txt.lastIndexOf("]");
  if (s !== -1 && e !== -1) txt = txt.slice(s, e + 1);

  let picks;
  try { picks = JSON.parse(txt); }
  catch (err) { throw new Error(`Curation JSON parse failed: ${err.message} | ${txt.slice(0, 300)}`); }

  const out = [];
  for (const p of picks) {
    const it = items[p.index];
    if (!it) continue;
    out.push({ title: it.title, link: it.link, source: it.source, summary: p.summary || "", topic: p.topic || "", company: p.company || "" });
  }
  return out.slice(0, TOP_N);
}

// Wrap each value in the shape Framer expects, based on the field's real type.
function valueFor(field, raw) {
  switch (field.type) {
    case "date": return { type: "date", value: raw };
    case "link": return { type: "link", value: raw };
    case "formattedText": return { type: "formattedText", value: raw };
    default: return { type: "string", value: String(raw ?? "") };
  }
}

async function pushToFramer(picks) {
  const dateStr = new Date().toISOString().slice(0, 10); // run date so the day's items group together
  const framer = await connect(FRAMER_PROJECT_URL, FRAMER_API_KEY);
  try {
    const collections = await framer.getCollections();
    const collection = collections.find(c => c.name === COLLECTION_NAME);
    if (!collection) throw new Error(`Collection "${COLLECTION_NAME}" not found. Found: ${collections.map(c => c.name).join(", ")}`);

    const fields = await collection.getFields();
    const byName = {};
    for (const f of fields) byName[f.name.toLowerCase()] = f;
    const set = (fd, name, raw) => { const f = byName[name.toLowerCase()]; if (f) fd[f.id] = valueFor(f, raw); };

    // Build items. New items on an unmanaged collection must OMIT id (id is only
    // for updating existing items). Slug is stable per-article (no date) so the
    // same story maps to the same slug and won't be re-added on later days.
    const built = picks.map(p => {
      const fd = {};
      set(fd, "Title", p.title);
      set(fd, "Date", dateStr);
      set(fd, "Summary", p.summary);
      set(fd, "Topic", p.topic);
      set(fd, "Company", p.company);
      set(fd, "Source", p.source);
      set(fd, "Link", p.link);
      const slug = `${slugify(p.title)}-${shortHash(p.link || p.title)}`.slice(0, 80);
      console.log("Pushing: ", slug, fieldData: fd);
      return { slug, fieldData: fd };
    });
    console.log("Finished pushing the baby out!");
    // Dedupe across days: skip anything whose slug is already in the collection.
    const existing = await collection.getItems();
    const existingSlugs = new Set(existing.map(i => i.slug));
    const items = built.filter(it => !existingSlugs.has(it.slug));

    if (items.length === 0) {
      console.log("No new stories today; everything is already in the collection.");
      return;
    }

    await collection.addItems(items);
    console.log(`Added ${items.length} new item(s) to "${COLLECTION_NAME}".`);
    await framer.publish();
    console.log("Published to live site.");
  } finally {
    await framer.disconnect();
  }
}

async function main() {
  console.log("Fetching feeds...");
  let items = dedupe(recent(await fetchFeeds()));
  console.log(`recent + deduped: ${items.length}`);
  items = keywordFilter(items);
  console.log(`after keyword filter: ${items.length}`);
  if (items.length === 0) { console.log("Nothing to curate today."); return; }

  const picks = await curate(items);
  console.log(`curated: ${picks.length}`);
  if (picks.length === 0) { console.log("No picks today."); return; }

  await pushToFramer(picks);
  console.log("Done.");
}

main().catch(e => { console.error(e); process.exit(1); });
