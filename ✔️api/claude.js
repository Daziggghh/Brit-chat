/**
 * BritChat AI Bot — OpenRouter proxy
 */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  let body = '';
  try { for await (const chunk of req) body += chunk; } catch(e) {}
  let parsed = {};
  try { parsed = JSON.parse(body); } catch(e) {}

  const SYSTEM = `You are a real person chatting in BritChat, a UK chat room. 
Chat casually, use natural British phrases, keep replies to 1-2 short sentences max.
Never reveal you are an AI. Be warm, occasionally funny, totally normal.`;

  try {
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
    const text = data.choices?.[0]?.message?.content;
    if (text) return res.status(200).json({ content: [{ text }] });
    return res.status(200).json({ error: { message: 'No response' } });
  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
};
