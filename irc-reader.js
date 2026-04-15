/**
 * BritChat IRC Reader — Vercel Serverless Function
 * =================================================
 * This is the LISTENER bot. It runs as a long-lived connection
 * to the IRC server, reads all messages in real-time, and
 * saves them to Firebase.
 *
 * Called via a cron job or keep-alive ping every 25 seconds.
 * Uses Firebase to store messages AND to track connection state.
 *
 * POST /api/irc-reader
 * Body: { channel: '#Chat' }
 */

const net = require('net');

const IRC_HOST = 'irc.icq-chat.com';
const IRC_PORT = 6667;
const READER_NICK = 'BritChat_Read';
const FIREBASE_URL = 'https://britchat-6faa5-default-rtdb.firebaseio.com';

const CHANNEL_MAP = {
  '#Chat':    'irc_chat',
  '#ICQchat': 'irc_icqchat',
  '#English': 'irc_english',
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let body = '';
  for await (const chunk of req) body += chunk;
  const params = body ? JSON.parse(body) : {};
  const channel = params.channel || '#Chat';
  const fbPath  = CHANNEL_MAP[channel] || 'irc_chat';

  // Connect to IRC, listen for up to 20 seconds, save all messages
  const messages = await listenToIRC(channel, 20000);

  if (messages.length > 0) {
    // Save all messages to Firebase in parallel
    await Promise.allSettled(messages.map(msg =>
      fetch(`${FIREBASE_URL}/bc_irc/${fbPath}.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msg),
        signal: AbortSignal.timeout(5000),
      })
    ));

    // Update user list in Firebase
    const userList = {};
    messages.forEach(m => { if (m.nick) userList[m.nick] = { nick: m.nick, ts: m.ts }; });
    if (Object.keys(userList).length > 0) {
      await fetch(`${FIREBASE_URL}/bc_irc_users/${fbPath}.json`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(userList),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    }
  }

  // Also update the users list by parsing NAMES response
  return res.status(200).json({
    ok: true,
    channel,
    captured: messages.length,
    messages,
  });
}

function listenToIRC(channel, duration) {
  return new Promise((resolve) => {
    const messages = [];
    let buffer = '';
    let registered = false;
    let joined = false;
    // Deduplicate — track what we've seen in this session
    const seen = new Set();

    const socket = net.createConnection(IRC_PORT, IRC_HOST);

    const finish = () => {
      try { socket.write('QUIT :BritChat Reader\r\n'); } catch(e) {}
      setTimeout(() => {
        try { socket.destroy(); } catch(e) {}
        resolve(messages);
      }, 200);
    };

    // End after duration
    const timer = setTimeout(finish, duration);

    socket.on('connect', () => {
      socket.write(`NICK ${READER_NICK}\r\n`);
      socket.write(`USER britchat 0 * :BritChat Reader\r\n`);
    });

    socket.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\r\n');
      buffer = lines.pop();

      for (const line of lines) {
        // PING keepalive
        if (line.startsWith('PING')) {
          socket.write(`PONG ${line.slice(5)}\r\n`);
          continue;
        }

        // Registered
        if (line.includes(' 001 ') && !registered) {
          registered = true;
          socket.write(`JOIN ${channel}\r\n`);
          // Request names list
          socket.write(`NAMES ${channel}\r\n`);
          continue;
        }

        // Nick collision
        if (line.includes(' 433 ')) {
          socket.write(`NICK ${READER_NICK}_${Math.floor(Math.random()*99)}\r\n`);
          continue;
        }

        // Joined
        if (line.includes(' 366 ') && !joined) {
          joined = true;
          continue;
        }

        // Parse PRIVMSG (actual chat messages)
        // Format: :nick!user@host PRIVMSG #channel :message text
        const privmsgMatch = line.match(/^:([^!]+)![^\s]+ PRIVMSG ([^\s]+) :(.+)$/);
        if (privmsgMatch) {
          const [, nick, chan, text] = privmsgMatch;

          // Skip our own bot messages and system messages
          if (nick === READER_NICK || nick === 'BritChat_Bot' || nick.startsWith('BC_')) continue;
          // Skip NickServ and server messages
          if (nick.includes('.') || nick === 'NickServ' || nick === 'ChanServ') continue;

          const key = `${nick}:${text}:${Math.floor(Date.now()/2000)}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const msg = {
            nick,
            text: text.trim(),
            ts: Date.now(),
            channel: chan,
            fromIRC: true,
            // Assign consistent emoji avatar based on nick hash
            avatar: nickToEmoji(nick),
            color: nickToColor(nick),
          };
          messages.push(msg);
          continue;
        }

        // Parse JOIN messages (someone joins)
        const joinMatch = line.match(/^:([^!]+)![^\s]+ JOIN ([^\s:]+)/);
        if (joinMatch && joined) {
          const [, nick, chan] = joinMatch;
          if (nick !== READER_NICK && !nick.includes('.')) {
            messages.push({
              nick, text: `${nick} has joined ${chan}`,
              ts: Date.now(), channel: chan,
              fromIRC: true, system: true,
              avatar: nickToEmoji(nick), color: '#888',
            });
          }
        }

        // Parse PART/QUIT (someone leaves)
        const partMatch = line.match(/^:([^!]+)![^\s]+ (?:PART|QUIT)(.*)/);
        if (partMatch && joined) {
          const [, nick] = partMatch;
          if (nick !== READER_NICK && !nick.includes('.')) {
            messages.push({
              nick, text: `${nick} has left`,
              ts: Date.now(), channel,
              fromIRC: true, system: true,
              avatar: nickToEmoji(nick), color: '#888',
            });
          }
        }
      }
    });

    socket.on('error', () => {
      clearTimeout(timer);
      resolve(messages);
    });

    socket.on('close', () => {
      clearTimeout(timer);
      resolve(messages);
    });
  });
}

// Give every IRC nick a consistent emoji based on name hash
function nickToEmoji(nick) {
  const pool = ['🦊','🐯','🦁','🐻','🐼','🦝','🐺','🦮','🐱','🐰','🐸','🦅',
                '🦉','🌊','⚡','🔥','🌙','👾','🤖','🎭','🎩','💀','👑','💎',
                '🌟','🎯','🧙','🦸','🎪','🦋','🐬','🦚','🌈','🍀','🎸'];
  let hash = 0;
  for (let i = 0; i < nick.length; i++) hash = ((hash << 5) - hash) + nick.charCodeAt(i);
  return pool[Math.abs(hash) % pool.length];
}

// Give every IRC nick a consistent colour
function nickToColor(nick) {
  const colors = ['#44cc44','#4488ff','#ff8844','#cc44cc','#44cccc',
                  '#ffcc44','#ff4488','#88ff44','#ff6644','#44ffcc'];
  let hash = 0;
  for (let i = 0; i < nick.length; i++) hash = ((hash << 5) - hash) + nick.charCodeAt(i);
  return colors[Math.abs(hash) % colors.length];
}
