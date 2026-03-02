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

  const now   = new Date();
  const yyyy  = now.getFullYear();
  const mm    = String(now.getMonth() + 1).padStart(2, "0");
  const dd    = String(now.getDate()).padStart(2, "0");
  const today = `${yyyy}-${mm}-${dd}`;

  // ── 2. Fetch today's puzzle from NYT ─────────────────────────────────────

  console.log(`Fetching NYT puzzle for ${today}...`);
   const nytData = await nytRes.json();

  // NYT v2 uses `categories` (each has `title` + `cards[{content}]`)
  const categories = Array.isArray(nytData.categories) ? nytData.categories : [];

  if (categories.length === 0) {
    return res.status(500).json({
      error: "NYT response missing categories; API format may have changed.",
      keys: Object.keys(nytData || {}),
    });
  }

  const newEntry = {
    id:   nytData.id,
    date: today,

    // optional: keep if you want a deterministic “starting order”
    startingOrder: categories.flatMap((g) => (g.cards || []).map((c) => c.content)),
    answers: categories.map((g) => ({
      level: -1,                // v2 doesn’t provide difficulty colors
      group: g.title,
      members: (g.cards || []).map((c) => c.content),
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
