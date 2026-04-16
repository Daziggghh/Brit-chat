/**
 * BRITTY BOT — BritChat Lounge
 * Wakes ONLY when a user joins (Firebase presence trigger)
 * Uses OpenRouter meta-llama/llama-4-maverick — same as old site
 * Run: node britty-bot.js
 * 24/7: pm2 start britty-bot.js --name britty
 */

const https = require('https');

const FB_URL   = 'britchat-6faa5-default-rtdb.firebaseio.com';
const OR_KEY   = process.env.OPENROUTER_API_KEY || 'YOUR_KEY_HERE';
const MODEL    = 'meta-llama/llama-4-maverick';
const ROOM     = 'lounge';
const BOT_USER = 'brittybot';

const knownUsers = new Set([BOT_USER]);
let lastMsgTs = 0;
let isBusy = false;

const log = msg => console.log(`[${new Date().toLocaleTimeString('en-GB')}] ${msg}`);

// Firebase REST
function fbGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: FB_URL, path: `${path}.json`, method: 'GET' }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
    });
    req.on('error', reject); req.end();
  });
}

function fbPush(path, data) {
  const body = JSON.stringify(data);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: FB_URL, path: `${path}.json`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
    req.on('error', reject); req.write(body); req.end();
  });
}

async function postMessage(text) {
  await fbPush(`/bc_msgs/${ROOM}`, {
    username: BOT_USER, text, ts: Date.now(),
    fmt: { color: '#7c6aff', bold: false, italic: false, underline: false }
  });
  log(`🤖 Said: ${text}`);
}

// OpenRouter — identical to old claudeFetch
async function askBritty(userMessage, userName) {
  return new Promise(resolve => {
    const body = JSON.stringify({
      model: MODEL, max_tokens: 400,
      messages: [
        { role: 'system', content: `You are Britty, a friendly witty British AI companion on BritChat UK. Warm, humorous British personality. Use light British slang naturally. Keep replies concise — 2-4 sentences max. The user's name is ${userName}.` },
        { role: 'user', content: userMessage }
      ]
    });
    const req = https.request({
      hostname: 'openrouter.ai', path: '/api/v1/chat/completions', method: 'POST',
      headers: {
        'Authorization': `Bearer ${OR_KEY}`, 'HTTP-Referer': 'https://britchat.co.uk',
        'X-Title': 'BritChat', 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d).choices?.[0]?.message?.content?.trim() || null); }
        catch(e) { resolve(null); }
      });
    });
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.write(body); req.end();
  });
}

// Greet a new user — ONLY trigger
async function greetUser(name, displayName) {
  if (isBusy) return;
  isBusy = true;
  try {
    log(`👋 New joiner: ${displayName || name}`);
    const reply = await askBritty(
      `A user called "${displayName || name}" just joined the BritChat Lounge. Give them a warm friendly British welcome in 1-2 sentences.`,
      displayName || name
    );
    await postMessage(reply || `Alright ${displayName || name}! 👋 Welcome to the BritChat Lounge! ☕🇬🇧`);
  } finally {
    isBusy = false;
  }
}

// Reply when @mentioned
async function replyToMsg(text, name) {
  if (isBusy) return;
  isBusy = true;
  try {
    log(`💬 ${name}: ${text}`);
    const reply = await askBritty(text, name);
    if (reply) await postMessage(reply);
  } finally {
    isBusy = false;
  }
}

// Watch Firebase presence — main trigger (polls bc_online every 5s)
async function watchPresence() {
  const online = await fbGet('/bc_online');
  if (!online) return;
  for (const [username, data] of Object.entries(online)) {
    if (username === BOT_USER) continue;
    if (!knownUsers.has(username)) {
      knownUsers.add(username);
      const room = data?.room || data?.currentRoom || '';
      // Only greet if they're in the lounge
      if (room === ROOM || room === 'lounge' || !room) {
        await greetUser(username, data?.name || data?.displayName);
      }
    }
  }
}

// Watch for @britty mentions in messages
async function watchMessages() {
  const msgs = await fbGet(`/bc_msgs/${ROOM}`);
  if (!msgs) return;
  const arr = Object.values(msgs).filter(m => m?.ts && m?.text).sort((a,b) => a.ts - b.ts);
  const newMsgs = arr.filter(m => m.ts > lastMsgTs && m.username !== BOT_USER);
  if (newMsgs.length) lastMsgTs = newMsgs[newMsgs.length-1].ts;
  for (const msg of newMsgs) {
    const lower = (msg.text || '').toLowerCase();
    if ((lower.includes('britty') || lower.includes('@brittybot')) && !isBusy) {
      await replyToMsg(msg.text, msg.username);
    }
  }
}

async function main() {
  log('🤖 BrittyBot starting...');
  if (!OR_KEY || OR_KEY === 'YOUR_KEY_HERE') {
    log('❌ Set OPENROUTER_API_KEY environment variable'); process.exit(1);
  }
  // Snapshot existing messages/users so we don't re-greet on restart
  const msgs = await fbGet(`/bc_msgs/${ROOM}`);
  if (msgs) {
    const arr = Object.values(msgs).filter(m => m?.ts);
    if (arr.length) lastMsgTs = Math.max(...arr.map(m => m.ts));
  }
  const online = await fbGet('/bc_online');
  if (online) Object.keys(online).forEach(u => knownUsers.add(u));
  log(`✅ Watching for new users in bc_msgs/${ROOM} — model: ${MODEL}`);
  setInterval(async () => {
    try { await watchPresence(); } catch(e) { log(`⚠️ ${e.message}`); }
    try { await watchMessages(); } catch(e) { log(`⚠️ ${e.message}`); }
  }, 5000);
}

main().catch(e => { log(`💥 ${e.message}`); process.exit(1); });
process.on('uncaughtException', e => log(`⚠️ ${e.message}`));
process.on('unhandledRejection', e => log(`⚠️ ${e}`));
