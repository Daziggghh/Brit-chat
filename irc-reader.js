/**
 * BritChat IRC Reader
 * Connects to IRC, reads messages, saves to Firebase
 * Called by Vercel cron every minute
 * Pure CommonJS
 */

const net = require('net');

const IRC_HOST = 'irc.icq-chat.com';
const IRC_PORT = 6667;
const FB = 'https://britchat-6faa5-default-rtdb.firebaseio.com';

// Channels to monitor
const CHANNELS = [
  { irc: '#Chat',    fb: 'irc_chat'    },
  { irc: '#ICQchat', fb: 'irc_icqchat' },
];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let body = '';
  try { for await (const chunk of req) body += chunk; } catch(e) {}
  let params = {};
  try { params = JSON.parse(body || '{}'); } catch(e) {}

  // Which channel to read (default: main Chat)
  const channelFilter = params.channel || null;
  const targets = channelFilter
    ? CHANNELS.filter(c => c.irc === channelFilter)
    : CHANNELS;

  const results = [];

  for (const target of targets) {
    try {
      const messages = await readIRC(target.irc, 18000);
      if (messages.length > 0) {
        // Save to Firebase
        await saveToFirebase(messages, target.fb);
        results.push({ channel: target.irc, count: messages.length });
      } else {
        results.push({ channel: target.irc, count: 0 });
      }
    } catch(e) {
      results.push({ channel: target.irc, error: e.message });
    }
  }

  return res.status(200).json({ ok: true, results, ts: Date.now() });
};

async function saveToFirebase(messages, fbPath) {
  // Save messages in parallel
  await Promise.allSettled(
    messages
      .filter(m => !m.system) // only real messages
      .map(m =>
        fetch(`${FB}/bc_irc/${fbPath}.json`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(m),
        })
      )
  );

  // Update user list
  const users = {};
  messages.forEach(m => {
    if (m.nick && !m.system) {
      users[m.nick.replace(/[.]/g, '_')] = { nick: m.nick, ts: m.ts, avatar: m.avatar, color: m.color };
    }
  });
  if (Object.keys(users).length > 0) {
    await fetch(`${FB}/bc_irc_users/${fbPath}.json`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(users),
    }).catch(() => {});
  }
}

function readIRC(channel, duration) {
  return new Promise((resolve) => {
    const messages = [];
    const seen = new Set();
    let buf = '';
    let registered = false;
    let botNick = 'BC_Reader' + Math.floor(Math.random() * 999);

    const finish = () => {
      try { socket.write('QUIT :BritChat\r\n'); } catch(e) {}
      setTimeout(() => { try { socket.destroy(); } catch(e) {} resolve(messages); }, 200);
    };

    const timer = setTimeout(finish, duration);
    const socket = net.createConnection({ host: IRC_HOST, port: IRC_PORT });

    socket.on('connect', () => {
      socket.write(`NICK ${botNick}\r\nUSER britchat 0 * :BritChat Reader\r\n`);
    });

    socket.on('data', (data) => {
      buf += data.toString('utf8');
      const lines = buf.split('\r\n');
      buf = lines.pop();

      for (const line of lines) {
        // PING keepalive
        if (line.startsWith('PING')) {
          socket.write('PONG ' + line.slice(5) + '\r\n');
          continue;
        }
        // 001 = registered
        if (!registered && line.includes(' 001 ')) {
          registered = true;
          socket.write(`JOIN ${channel}\r\n`);
          continue;
        }
        // 433 = nick collision
        if (line.includes(' 433 ')) {
          botNick = 'BC_R' + Math.floor(Math.random() * 9999);
          socket.write(`NICK ${botNick}\r\n`);
          continue;
        }

        // PRIVMSG — real chat message
        // :nick!user@host PRIVMSG #channel :text
        const pm = line.match(/^:([^!@]+)![^\s]+ PRIVMSG ([^\s]+) :(.+)$/);
        if (pm) {
          const [, nick, chan, text] = pm;
          // Skip bots and servers
          if (nick === botNick) continue;
          if (nick === 'NickServ' || nick === 'ChanServ' || nick.includes('.')) continue;
          if (nick.startsWith('BC_')) continue; // skip our own bridge messages
          // Deduplicate
          const key = nick + ':' + text.slice(0, 30);
          if (seen.has(key)) continue;
          seen.add(key);

          messages.push({
            nick,
            text: text.trim(),
            ts: Date.now(),
            channel: chan,
            fromIRC: true,
            avatar: nickToEmoji(nick),
            color: nickToColor(nick),
          });
          continue;
        }

        // JOIN — user joined
        const joinM = line.match(/^:([^!@]+)![^\s]+ JOIN ([^\s:]+)/);
        if (joinM && registered) {
          const [, nick, chan] = joinM;
          if (nick !== botNick && !nick.includes('.') && !nick.startsWith('BC_')) {
            messages.push({
              nick, text: `${nick} joined the chat`,
              ts: Date.now(), channel: chan,
              fromIRC: true, system: true,
              avatar: nickToEmoji(nick), color: '#888',
            });
          }
        }
      }
    });

    socket.on('error', () => { clearTimeout(timer); resolve(messages); });
    socket.on('close', () => { clearTimeout(timer); resolve(messages); });
  });
}

const EMOJI_POOL = ['🦊','🐯','🦁','🐻','🐼','🦝','🐺','🐱','🐰','🐸','🦅','🦉',
  '🌊','⚡','🔥','🌙','👾','🤖','🎭','🎩','💀','👑','💎','🌟','🎯','🧙',
  '🦸','🎪','🦋','🐬','🦚','🌈','🍀','🎸','🏄','🧊'];

function nickToEmoji(nick) {
  let h = 0;
  for (let i = 0; i < nick.length; i++) h = ((h << 5) - h) + nick.charCodeAt(i);
  return EMOJI_POOL[Math.abs(h) % EMOJI_POOL.length];
}

const COLORS = ['#ff9944','#4488ff','#ff4488','#44cccc','#ffcc44','#ff6644','#88ff44','#cc44ff','#44ffaa'];

function nickToColor(nick) {
  let h = 0;
  for (let i = 0; i < nick.length; i++) h = ((h << 5) - h) + nick.charCodeAt(i);
  return COLORS[Math.abs(h) % COLORS.length];
}
