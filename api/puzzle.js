// This file runs secretly on Vercel's servers — visitors to your site
// never see it or your API key. It receives a request from your app,
// calls the Anthropic API using your secret key, and sends the puzzle back.

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { today } = req.body;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY, // secret key stored safely in Vercel
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{
          role: 'user',
          content:
            `Search the web for the NYT Connections puzzle answers for ${today}. ` +
            `Then respond with ONLY a raw JSON object — no prose, no markdown fences.\n\n` +
            `Required shape:\n` +
            `{"date":"${today}","categories":[` +
            `{"title":"EXACT CATEGORY TITLE","color":0,"cards":["WORD1","WORD2","WORD3","WORD4"]},` +
            `{"title":"EXACT CATEGORY TITLE","color":1,"cards":["WORD1","WORD2","WORD3","WORD4"]},` +
            `{"title":"EXACT CATEGORY TITLE","color":2,"cards":["WORD1","WORD2","WORD3","WORD4"]},` +
            `{"title":"EXACT CATEGORY TITLE","color":3,"cards":["WORD1","WORD2","WORD3","WORD4"]}` +
            `]}\n\n` +
            `color: 0=Yellow (easiest), 1=Green, 2=Blue, 3=Purple (hardest). ` +
            `Use the real category titles and words from today's actual puzzle. JSON only.`,
        }],
      }),
    });

    const data = await response.json();
    const text = data.content?.map((b) => b.text || '').join('') ?? '';
    const match = text.match(/\{[\s\S]*\}/);

    if (!match) {
      return res.status(500).json({ error: 'No puzzle data found in response' });
    }

    const puzzle = JSON.parse(match[0]);
    return res.status(200).json(puzzle);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
