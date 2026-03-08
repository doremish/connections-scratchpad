// ─────────────────────────────────────────────────────────────────────────────
// fetch-connections-archive.mjs
//
// Fetches the last 30 days of NYT Connections puzzles fresh from the v2 API
// and writes a complete connections.json you can drop into public/.
//
// Usage (Node 18+, run from anywhere):
//   node fetch-connections-archive.mjs
//
// Output: connections.json in the current directory.
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";

const NYT_API_BASE = "https://www.nytimes.com/svc/connections/v2";
const DAYS         = 30;
const DELAY_MS     = 500;
const OUT_PATH     = "./connections.json";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function toDateString(date) {
  return date.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function extractEntry(nytData, dateStr) {
  const rawGroups =
    (nytData.categories?.length     > 0 && nytData.categories)     ||
    (nytData.startingGroups?.length > 0 && nytData.startingGroups) ||
    (nytData.answers?.length        > 0 && nytData.answers)        ||
    [];
  if (rawGroups.length === 0) return null;

  // Build startingOrder from position field
  const allCards = rawGroups.flatMap((g) =>
    (g.cards ?? []).map((c) => ({
      word:     c.content ?? c.text ?? c.image_alt_text ?? (typeof c === "string" ? c : null),
      position: typeof c.position === "number" ? c.position : null,
    }))
  ).filter((c) => c.word);

  const hasPositions = allCards.length === 16 && allCards.every((c) => c.position !== null);
  const startingOrder = hasPositions
    ? [...allCards].sort((a, b) => a.position - b.position).map((c) => c.word)
    : null;

  // Extract members (preserve image objects)
  const extractMembers = (g) => {
    if (g.members?.length > 0) return g.members;
    return (g.cards ?? []).map((c) => {
      if (c.image_url) return { image_url: c.image_url, alt: c.image_alt_text ?? c.alt ?? "?" };
      return c.content ?? c.text ?? c;
    }).filter(Boolean);
  };

  return {
    id:   nytData.id,
    date: dateStr,
    ...(startingOrder && { startingOrder }),
    answers: rawGroups.map((g, idx) => ({
      level:   g.level ?? g.difficulty ?? -1,
      group:   g.group ?? g.title ?? `Group ${idx + 1}`,
      members: extractMembers(g),
    })),
  };
}

async function main() {
  const today = new Date();
  const dates = Array.from({ length: DAYS }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    return toDateString(d);
  }).reverse(); // oldest first

  console.log(`Fetching ${DAYS} days: ${dates[0]} → ${dates[dates.length - 1]}\n`);

  const results = [];
  let ok = 0, skipped = 0;

  for (const date of dates) {
    process.stdout.write(`  ${date} … `);
    try {
      const res = await fetch(`${NYT_API_BASE}/${date}.json`);
      if (!res.ok) {
        console.log(`HTTP ${res.status} — skipped`);
        skipped++;
        await sleep(DELAY_MS);
        continue;
      }
      const data  = await res.json();
      const entry = extractEntry(data, date);
      if (!entry) {
        console.log("parse error — skipped");
        skipped++;
      } else {
        const orderNote = entry.startingOrder ? "✅ with order" : "⚠️  no order";
        console.log(orderNote);
        results.push(entry);
        ok++;
      }
    } catch (e) {
      console.log(`network error (${e.message}) — skipped`);
      skipped++;
    }
    await sleep(DELAY_MS);
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify(results, null, 2), "utf8");
  console.log(`\nWrote ${results.length} entries → ${OUT_PATH}`);
  console.log(`OK: ${ok}  |  Skipped: ${skipped}`);
  if (skipped > 0) console.log("Skipped dates simply won't appear in the archive.");
}

main().catch((e) => { console.error(e); process.exit(1); });
