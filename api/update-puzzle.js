// ─────────────────────────────────────────────────────────────────────────────
// api/update-puzzle.js
//
// This runs automatically every morning at 9am UTC (5am ET) via Vercel cron.
// It fetches today's puzzle from the NYT API (no CORS issue — this runs on a
// server, not in a browser), then appends it to your own connections.json
// archive stored in your GitHub repo.
//
// Required environment variables (set these in Vercel → Settings → Environment Variables):
//   GITHUB_TOKEN  — a GitHub personal access token with "repo" write access
//   GITHUB_REPO   — your repo in the format "yourusername/connections-scratchpad"
// ─────────────────────────────────────────────────────────────────────────────

const NYT_API_BASE  = "https://www.nytimes.com/svc/connections/v2";
const ARCHIVE_PATH  = "public/connections.json";  // file path inside your GitHub repo
const GITHUB_API    = "https://api.github.com";

export default async function handler(req, res) {

  // ── 1. Build today's date string ──────────────────────────────────────────

  const now   = new Date();
  const yyyy  = now.getFullYear();
  const mm    = String(now.getMonth() + 1).padStart(2, "0");
  const dd    = String(now.getDate()).padStart(2, "0");
  const today = `${yyyy}-${mm}-${dd}`;

  // ── 2. Fetch today's puzzle from the NYT API ───────────────────────────────
  // This works here because it runs server-side — no CORS restrictions.

  console.log(`Fetching NYT puzzle for ${today}...`);
  const nytRes = await fetch(`${NYT_API_BASE}/${today}.json`);

  if (!nytRes.ok) {
    console.log(`NYT returned ${nytRes.status} — today's puzzle may not be published yet.`);
    return res.status(200).json({ message: `NYT puzzle not available yet for ${today}` });
  }

  const nytData = await nytRes.json();

  // Normalise into our archive format
  const newEntry = {
    id:      nytData.id,
    date:    today,
    answers: (nytData.answers || []).map((group, idx) => ({
      level:   group.level ?? -1,
      group:   group.group ?? `Group ${idx + 1}`,
      members: group.members ?? [],
    })),
  };

  // ── 3. Read your current archive from GitHub ───────────────────────────────

  const { GITHUB_TOKEN, GITHUB_REPO } = process.env;

  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    return res.status(500).json({ error: "GITHUB_TOKEN or GITHUB_REPO env variable is missing." });
  }

  const githubHeaders = {
    "Authorization": `Bearer ${GITHUB_TOKEN}`,
    "Accept":        "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const fileRes = await fetch(
    `${GITHUB_API}/repos/${GITHUB_REPO}/contents/${ARCHIVE_PATH}`,
    { headers: githubHeaders }
  );

  if (!fileRes.ok) {
    return res.status(500).json({ error: `Could not read archive from GitHub: ${fileRes.status}` });
  }

  const fileData  = await fileRes.json();
  const fileSha   = fileData.sha;  // needed by GitHub API to update an existing file
  const existing  = JSON.parse(Buffer.from(fileData.content, "base64").toString("utf8"));

  // ── 4. Check if today is already in the archive ────────────────────────────

  const alreadyExists = existing.some((entry) => entry.date === today);
  if (alreadyExists) {
    console.log(`${today} is already in the archive — nothing to do.`);
    return res.status(200).json({ message: `${today} already exists in archive.` });
  }

  // ── 5. Append today's entry and save back to GitHub ───────────────────────

  const updated     = [...existing, newEntry];
  const updatedJson = JSON.stringify(updated, null, 2);
  const encoded     = Buffer.from(updatedJson).toString("base64");

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

  console.log(`Successfully added ${today} to archive.`);
  return res.status(200).json({ message: `Added ${today} to archive.` });
}
