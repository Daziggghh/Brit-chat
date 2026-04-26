// api/claude.js — Vercel Serverless Function
// Routes AI requests through OpenRouter (openrouter.ai)
//
// Set this in Vercel → Project Settings → Environment Variables:
//   OPENROUTER_KEY = sk-or-v1-xxxxxxxxxxxxxxxx

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.OPENROUTER_KEY;
  if (!apiKey) {
    console.error('OPENROUTER_KEY is not set');
    return res.status(500).json({ error: 'OPENROUTER_KEY not configured in Vercel environment variables' });
  }

  const { messages, model, max_tokens } = req.body || {};

  if (!messages || !messages.length) {
    return res.status(400).json({ error: 'No messages provided' });
  }

  try {
    const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://britchat.co.uk',
        'X-Title': 'Brit Chat',
      },
      body: JSON.stringify({
        model: model || 'anthropic/claude-haiku-4-5',
        max_tokens: max_tokens || 400,
        messages,
      }),
    });

    const data = await orRes.json();

    if (!orRes.ok) {
      console.error('OpenRouter error:', data);
      return res.status(orRes.status).json({
        error: data?.error?.message || 'OpenRouter API error',
        details: data,
      });
    }

    // OpenRouter returns OpenAI-compatible format — normalise to Anthropic format
    // so the frontend works without changes
    const text = data?.choices?.[0]?.message?.content || '';
    return res.status(200).json({
      content: [{ type: 'text', text }]
    });

  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(500).json({ error: 'Proxy failed: ' + err.message });
  }
}
