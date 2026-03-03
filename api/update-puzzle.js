// ─────────────────────────────────────────────────────────────────────────────
// api/update-puzzle.js
//
// Runs automatically every morning at 9am UTC via Vercel cron.
// - Fetches today's puzzle from NYT (no CORS issue — this runs server-side)
// - Appends it to your archive
// - Trims anything older than 30 days
// - Saves back to GitHub
//
// Required environment variables (Vercel → Settings → Environment Variables):
//   GITHUB_TOKEN  — GitHub personal access token with "repo" write access
//   GITHUB_REPO   — your repo e.g. "doremish/connections-scratchpad"
// ─────────────────────────────────────────────────────────────────────────────

const NYT_API_BASE  = "https://www.nytimes.com/svc/connections/v2";
const ARCHIVE_PATH  = "public/connections.json";
const GITHUB_API    = "https://api.github.com";
const DAYS_TO_KEEP  = 30;

export default async function handler(req, res) {

  // ── 1. Build today's date ─────────────────────────────────────────────────

  // Use NYT's timezone (ET) — this is the date NYT uses for puzzle IDs
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  // ── 2. Fetch today's puzzle from NYT ─────────────────────────────────────

  console.log(`Fetching NYT puzzle for ${today}...`);
  const nytRes = await fetch(`${NYT_API_BASE}/${today}.json`);

  if (!nytRes.ok) {
    console.log(`NYT returned ${nytRes.status} — puzzle may not be published yet.`);
    return res.status(200).json({ message: `NYT puzzle not available yet for ${today}` });
  }

  const nytData = await nytRes.json();

  // NYT v2 API stores words in g.cards[].content, not g.members.
  // Fall back chain uses .length > 0 check because [] is truthy and would
  // short-circuit the || before reaching a non-empty array.
  const rawGroups =
    (nytData.startingGroups?.length  > 0 && nytData.startingGroups) ||
    (nytData.answers?.length         > 0 && nytData.answers)        ||
    (nytData.categories?.length      > 0 && nytData.categories)     ||
    [];

  if (rawGroups.length === 0) {
    console.log("No groups found in NYT response. Keys:", Object.keys(nytData));
    return res.status(200).json({ message: `NYT puzzle for ${today} returned no groups — skipping.` });
  }

  // Extract member words from either .members (old) or .cards[].content (v2)
  const extractMembers = (g) =>
    g.members?.length > 0
      ? g.members
      : (g.cards ?? []).map((c) => c.content ?? c.text ?? c).filter(Boolean);

  const newEntry = {
    id:            nytData.id,
    date:          today,
    startingOrder: rawGroups.flatMap(extractMembers),
    answers:       rawGroups.map((g, idx) => ({
      level:   g.level ?? g.difficulty ?? -1,
      group:   g.group ?? g.title ?? `Group ${idx + 1}`,
      members: extractMembers(g),
    })),
  };

  // ── 3. Read current archive from GitHub ───────────────────────────────────
  // File stays under 1MB (30 entries) so the standard Contents API works fine.

  const { GITHUB_TOKEN, GITHUB_REPO } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    return res.status(500).json({ error: "GITHUB_TOKEN or GITHUB_REPO env variable is missing." });
  }

  const githubHeaders = {
    "Authorization":        `Bearer ${GITHUB_TOKEN}`,
    "Accept":               "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const fileRes = await fetch(
    `${GITHUB_API}/repos/${GITHUB_REPO}/contents/${ARCHIVE_PATH}`,
    { headers: githubHeaders }
  );
  if (!fileRes.ok) {
    return res.status(500).json({ error: `Could not read archive from GitHub: ${fileRes.status}` });
  }

  const fileData   = await fileRes.json();
  const fileSha    = fileData.sha;
  const rawContent = Buffer.from(fileData.content, "base64").toString("utf8");

  let existing;
  try {
    existing = JSON.parse(rawContent);
  } catch (e) {
    return res.status(500).json({ error: "Archive JSON is invalid.", detail: e.message });
  }

  // ── 4. Check if today already exists ─────────────────────────────────────

  if (existing.some((e) => e.date === today)) {
    console.log(`${today} already in archive — nothing to do.`);
    return res.status(200).json({ message: `${today} already exists in archive.` });
  }

  // ── 5. Append today and trim to last 30 days ──────────────────────────────

  const updated = [...existing, newEntry]
    .sort((a, b) => a.date.localeCompare(b.date))  // ensure chronological order
    .slice(-DAYS_TO_KEEP);                          // keep only the most recent 30

  console.log(`Archive updated: ${updated.length} entries, oldest: ${updated[0].date}`);

  // ── 6. Save back to GitHub ────────────────────────────────────────────────

  const encoded   = Buffer.from(JSON.stringify(updated, null, 2)).toString("base64");
  const commitRes = await fetch(
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

  if (!commitRes.ok) {
    const err = await commitRes.json();
    return res.status(500).json({ error: "Failed to commit to GitHub", detail: err });
  }

  console.log(`Successfully saved ${today} to archive.`);
  return res.status(200).json({
    message: `Added ${today}. Archive now has ${updated.length} entries.`,
    oldest:  updated[0].date,
    newest:  updated[updated.length - 1].date,
  });
}
