/**
 * Claude AI proxy for BritChat bot responses
 * Same pattern as Poker Chimps claude.js
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);

    const SYSTEM = `You are a real person in a UK chat room. NOT an AI.
Reply in 1-2 casual British sentences max. Use light UK slang naturally.
Never say you're an AI. Never write lists. Be conversational and warm.
Emojis: use sparingly, only when it fits naturally.`;

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_KEY}`,
        'HTTP-Referer': 'https://britchat.co.uk',
        'X-Title': 'BritChat',
      },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-maverick',
        max_tokens: parsed.max_tokens || 80,
        messages: [
          { role: 'system', content: parsed.system ? SYSTEM + '\n\n' + parsed.system : SYSTEM },
          ...(parsed.messages || []),
        ],
        temperature: 1.1,
      })
    });

    const data = await response.json();
    if (data.error) return res.status(200).json({ error: { message: data.error.message } });
    const text = data.choices?.[0]?.message?.content;
    if (text) return res.status(200).json({ content: [{ text }] });
    return res.status(200).json({ error: { message: 'Empty response' } });

  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
}
