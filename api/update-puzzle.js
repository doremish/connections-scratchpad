// ─────────────────────────────────────────────────────────────────────────────
// api/update-puzzle.js
//
// Runs automatically every morning via Vercel cron.
// - Fetches today's puzzle from NYT (no CORS issue — this runs server-side)
// - Appends it to your archive
// - Trims anything older than 30 days
// - Saves back to GitHub
//
// Required environment variables (Vercel → Settings → Environment Variables):
//   GITHUB_TOKEN  — GitHub personal access token with "repo" write access
//   GITHUB_REPO   — your repo e.g. "doremish/connections-scratchpad"
//   NTFY_TOPIC    — your ntfy.sh topic, e.g. "connections-scratchpad-doremish"
//                   (omit to skip notifications)
// ─────────────────────────────────────────────────────────────────────────────

const NYT_API_BASE  = "https://www.nytimes.com/svc/connections/v2";
const ARCHIVE_PATH  = "public/connections.json";
const GITHUB_API    = "https://api.github.com";
const DAYS_TO_KEEP  = 30;

// ── Notification helper ───────────────────────────────────────────────────────

async function notify(topic, title, message, isError = false) {
  if (!topic) return;
  try {
    await fetch(`https://ntfy.sh/${topic}`, {
      method: "POST",
      headers: {
        "Title":    title,
        "Priority": isError ? "high" : "default",
        "Tags":     isError ? "warning,newspaper" : "white_check_mark,newspaper",
        "Content-Type": "text/plain",
      },
      body: message,
    });
  } catch (e) {
    console.warn("ntfy notification failed:", e.message);
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {

  const { GITHUB_TOKEN, GITHUB_REPO, NTFY_TOPIC } = process.env;

  // ── 1. Build today's date ─────────────────────────────────────────────────

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  // ── 2. Fetch today's puzzle from NYT ─────────────────────────────────────

  console.log(`Fetching NYT puzzle for ${today}...`);
  let nytRes;
  try {
    nytRes = await fetch(`${NYT_API_BASE}/${today}.json`);
  } catch (e) {
    const msg = `Network error reaching NYT API: ${e.message}`;
    console.error(msg);
    await notify(NTFY_TOPIC, "❌ Connections cron failed", msg, true);
    return res.status(500).json({ error: msg });
  }

  if (!nytRes.ok) {
    const msg = `NYT returned ${nytRes.status} for ${today} — puzzle may not be published yet.`;
    console.log(msg);
    await notify(NTFY_TOPIC, "⚠️ Connections puzzle not available", msg, true);
    return res.status(200).json({ message: msg });
  }

  const nytData = await nytRes.json();

  // NYT v2 API: categories are in nytData.categories[].cards[]
  // Each card has { content, position } where position is the actual scrambled
  // grid order NYT shows players. Fall back to older field names for resilience.
  const rawGroups =
    (nytData.categories?.length      > 0 && nytData.categories)     ||
    (nytData.startingGroups?.length  > 0 && nytData.startingGroups) ||
    (nytData.answers?.length         > 0 && nytData.answers)        ||
    [];

  if (rawGroups.length === 0) {
    const msg = `NYT puzzle for ${today} returned no groups. Keys: ${Object.keys(nytData).join(", ")}`;
    console.log(msg);
    await notify(NTFY_TOPIC, "⚠️ Connections puzzle parse error", msg, true);
    return res.status(200).json({ message: msg });
  }

  // Extract member words from either .members (old) or .cards[].content (v2)
  const extractMembers = (g) =>
    g.members?.length > 0
      ? g.members
      : (g.cards ?? []).map((c) => c.content ?? c.text ?? c).filter(Boolean);

  // Build the true NYT starting order by sorting all cards across all groups
  // by their position field. This is the actual scrambled grid players see.
  // Falls back to null if position data isn't present (older API responses).
  const allCards = rawGroups.flatMap((g) =>
    (g.cards ?? []).map((c) => ({
      word:     c.content ?? c.text ?? (typeof c === "string" ? c : null),
      position: typeof c.position === "number" ? c.position : null,
    }))
  ).filter((c) => c.word);

  const hasPositions = allCards.length > 0 && allCards.every((c) => c.position !== null);
  const startingOrder = hasPositions
    ? [...allCards].sort((a, b) => a.position - b.position).map((c) => c.word)
    : null; // null = App will fall back to shuffle

  const newEntry = {
    id:      nytData.id,
    date:    today,
    ...(startingOrder && { startingOrder }), // only include when we have real position data
    answers: rawGroups.map((g, idx) => ({
      level:   g.level ?? g.difficulty ?? -1,
      group:   g.group ?? g.title ?? `Group ${idx + 1}`,
      members: extractMembers(g),
    })),
  };

  // ── 3. Read current archive from GitHub ───────────────────────────────────

  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    const msg = "GITHUB_TOKEN or GITHUB_REPO env variable is missing.";
    await notify(NTFY_TOPIC, "❌ Connections cron failed", msg, true);
    return res.status(500).json({ error: msg });
  }

  const githubHeaders = {
    "Authorization":        `Bearer ${GITHUB_TOKEN}`,
    "Accept":               "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  let fileData;
  try {
    const fileRes = await fetch(
      `${GITHUB_API}/repos/${GITHUB_REPO}/contents/${ARCHIVE_PATH}`,
      { headers: githubHeaders }
    );
    if (!fileRes.ok) {
      const msg = `Could not read archive from GitHub: ${fileRes.status}`;
      await notify(NTFY_TOPIC, "❌ Connections cron failed", msg, true);
      return res.status(500).json({ error: msg });
    }
    fileData = await fileRes.json();
  } catch (e) {
    const msg = `Network error reading GitHub archive: ${e.message}`;
    await notify(NTFY_TOPIC, "❌ Connections cron failed", msg, true);
    return res.status(500).json({ error: msg });
  }

  const fileSha    = fileData.sha;
  const rawContent = Buffer.from(fileData.content, "base64").toString("utf8");

  let existing;
  try {
    existing = JSON.parse(rawContent);
  } catch (e) {
    const msg = `Archive JSON is invalid: ${e.message}`;
    await notify(NTFY_TOPIC, "❌ Connections cron failed", msg, true);
    return res.status(500).json({ error: msg });
  }

  // ── 4. Check if today already exists ─────────────────────────────────────

  if (existing.some((e) => e.date === today)) {
    console.log(`${today} already in archive — nothing to do.`);
    return res.status(200).json({ message: `${today} already exists in archive.` });
  }

  // ── 5. Append today and trim to last 30 days ──────────────────────────────

  const updated = [...existing, newEntry]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-DAYS_TO_KEEP);

  console.log(`Archive updated: ${updated.length} entries, oldest: ${updated[0].date}`);

  // ── 6. Save back to GitHub ────────────────────────────────────────────────

  const encoded = Buffer.from(JSON.stringify(updated, null, 2)).toString("base64");
  let commitRes;
  try {
    commitRes = await fetch(
      `${GITHUB_API}/repos/${GITHUB_REPO}/contents/${ARCHIVE_PATH}`,
      {
        method:  "PUT",
        headers: { ...githubHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: `chore: add Connections puzzle for ${today}`,
          content: encoded,
          sha:     fileSha,
        }),
      }
    );
  } catch (e) {
    const msg = `Network error committing to GitHub: ${e.message}`;
    await notify(NTFY_TOPIC, "❌ Connections cron failed", msg, true);
    return res.status(500).json({ error: msg });
  }

  if (!commitRes.ok) {
    const err = await commitRes.json();
    const msg = `GitHub commit failed (${commitRes.status}): ${JSON.stringify(err)}`;
    await notify(NTFY_TOPIC, "❌ Connections cron failed", msg, true);
    return res.status(500).json({ error: "Failed to commit to GitHub", detail: err });
  }

  // ── 7. Success! ───────────────────────────────────────────────────────────

  const orderNote  = startingOrder ? "with NYT position order" : "shuffled (no position data)";
  const successMsg = `Puzzle #${newEntry.id} for ${today} added (${orderNote}). Archive: ${updated.length} entries (${updated[0].date} → ${updated[updated.length - 1].date}).`;
  console.log("Successfully saved", today, "to archive.");
  await notify(NTFY_TOPIC, "✅ Connections puzzle saved", successMsg, false);

  return res.status(200).json({
    message:      `Added ${today}. Archive now has ${updated.length} entries.`,
    oldest:       updated[0].date,
    newest:       updated[updated.length - 1].date,
    startingOrder: orderNote,
  });
}
