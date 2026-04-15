/**
 * BritChat IRC Bridge — Vercel Serverless Function
 * Connects to irc.icq-chat.com as a real IRC user
 * Reads messages from #ICQchat and writes to Firebase
 * Receives messages from Firebase and posts to IRC
 *
 * Endpoints:
 *   POST /api/irc-bridge { action:'fetch', channel:'#ICQchat', since:timestamp }
 *     → returns new IRC messages since timestamp
 *
 *   POST /api/irc-bridge { action:'send', nick:'DrunkJoker', text:'hello!', channel:'#ICQchat' }
 *     → connects to IRC, sends the message, disconnects
 *
 *   POST /api/irc-bridge { action:'users', channel:'#ICQchat' }
 *     → returns list of users currently in channel
 *
 * How it works:
 *   Vercel functions are stateless so we can't keep a persistent connection.
 *   Instead we use a "connect → do thing → disconnect" pattern.
 *   For fetching messages we connect, wait for recent history replay,
 *   collect messages for ~3 seconds, then return them.
 *   Messages are also stored in Firebase so BritChat can poll them.
 *
 * IRC connection: irc.icq-chat.com:6667 (plain TCP)
 */

import net from 'net';

const IRC_HOST    = 'irc.icq-chat.com';
const IRC_PORT    = 6667;
const IRC_CHANNEL = '#ICQchat';
const TIMEOUT_MS  = 6000; // max time to wait for IRC response

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let body = '';
  for await (const chunk of req) body += chunk;
  const params = body ? JSON.parse(body) : {};

  const { action = 'fetch', nick = 'BritChatBot', text = '', channel = IRC_CHANNEL, since = 0 } = params;

  try {
    if (action === 'send') {
      const result = await ircSend(nick, channel, text);
      return res.status(200).json(result);
    }

    if (action === 'users') {
      const result = await ircUsers(channel);
      return res.status(200).json(result);
    }

    // Default: fetch recent messages
    const result = await ircFetch(channel, since);
    return res.status(200).json(result);

  } catch (err) {
    return res.status(200).json({ ok: false, error: err.message, messages: [], users: [] });
  }
}

/**
 * Connect to IRC, join channel, collect messages for a few seconds, return them
 */
function ircFetch(channel, since) {
  return new Promise((resolve) => {
    const messages = [];
    const users = [];
    let connected = false;
    let joined = false;
    let timer;
    let namesReceived = false;

    const nick = 'BritChatReader' + Math.floor(Math.random() * 9000 + 1000);

    const socket = net.createConnection({ host: IRC_HOST, port: IRC_PORT });
    socket.setEncoding('utf8');

    const done = () => {
      clearTimeout(timer);
      try { socket.write(`QUIT :BritChat Bridge\r\n`); socket.destroy(); } catch(e){}
      resolve({ ok: true, messages, users });
    };

    timer = setTimeout(done, TIMEOUT_MS);

    let buffer = '';

    socket.on('connect', () => {
      connected = true;
      socket.write(`NICK ${nick}\r\n`);
      socket.write(`USER britchat 0 * :BritChat IRC Bridge\r\n`);
    });

    socket.on('data', (data) => {
      buffer += data;
      const lines = buffer.split('\r\n');
      buffer = lines.pop(); // incomplete last line

      for (const line of lines) {
        if (!line) continue;

        // Respond to PING to keep connection alive
        if (line.startsWith('PING ')) {
          socket.write(`PONG ${line.slice(5)}\r\n`);
          continue;
        }

        // Parse IRC message: :nick!user@host COMMAND params :trailing
        const parsed = parseIRC(line);
        if (!parsed) continue;

        // Once we get welcome (001), join the channel
        if (parsed.command === '001' && !joined) {
          joined = true;
          socket.write(`JOIN ${channel}\r\n`);
          continue;
        }

        // PRIVMSG — someone said something
        if (parsed.command === 'PRIVMSG' && parsed.params[0] === channel) {
          const ts = Date.now();
          if (ts >= since) {
            messages.push({
              ts,
              nick: parsed.nick,
              text: parsed.trailing,
              source: 'irc',
              channel,
            });
          }
          continue;
        }

        // Names list (353) — who's in the channel
        if (parsed.command === '353') {
          const nameList = parsed.trailing.split(' ').filter(Boolean);
          nameList.forEach(n => {
            const clean = n.replace(/^[@+]/, ''); // strip op/voice prefix
            if (clean && !users.find(u => u.nick === clean)) {
              users.push({ nick: clean, op: n.startsWith('@'), voice: n.startsWith('+') });
            }
          });
          continue;
        }

        // End of names (366) — all names received, we have enough, exit
        if (parsed.command === '366') {
          namesReceived = true;
          // Give it 2.5 more seconds to collect PRIVMSG history
          clearTimeout(timer);
          timer = setTimeout(done, 2500);
          continue;
        }
      }
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message, messages, users });
    });

    socket.on('close', () => {
      clearTimeout(timer);
      resolve({ ok: true, messages, users });
    });
  });
}

/**
 * Connect as the user's nick, send a message to the channel, disconnect
 */
function ircSend(nick, channel, text) {
  return new Promise((resolve) => {
    // Sanitise nick for IRC: max 16 chars, no spaces/special chars
    const ircNick = sanitiseNick(nick);
    let sent = false;
    let joined = false;
    let timer;

    const socket = net.createConnection({ host: IRC_HOST, port: IRC_PORT });
    socket.setEncoding('utf8');

    const done = (success) => {
      clearTimeout(timer);
      sent = true;
      try { socket.write(`QUIT :BritChat\r\n`); socket.destroy(); } catch(e){}
      resolve({ ok: success, nick: ircNick, text, channel });
    };

    timer = setTimeout(() => done(false), TIMEOUT_MS);

    let buffer = '';

    socket.on('connect', () => {
      socket.write(`NICK ${ircNick}\r\n`);
      socket.write(`USER britchat 0 * :BritChat User\r\n`);
    });

    socket.on('data', (data) => {
      if (sent) return;
      buffer += data;
      const lines = buffer.split('\r\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line) continue;

        if (line.startsWith('PING ')) {
          socket.write(`PONG ${line.slice(5)}\r\n`);
          continue;
        }

        const parsed = parseIRC(line);
        if (!parsed) continue;

        // Nick already in use — add suffix
        if (parsed.command === '433') {
          socket.write(`NICK ${ircNick}_BC\r\n`);
          continue;
        }

        // Welcome — join channel
        if (parsed.command === '001' && !joined) {
          joined = true;
          socket.write(`JOIN ${channel}\r\n`);
          continue;
        }

        // Joined channel successfully — send message
        if (parsed.command === 'JOIN' && parsed.nick === ircNick.replace('_BC','') || 
            parsed.command === 'JOIN' && joined) {
          if (joined && !sent) {
            // Small delay to ensure join is processed
            setTimeout(() => {
              socket.write(`PRIVMSG ${channel} :${text}\r\n`);
              setTimeout(() => done(true), 500);
            }, 300);
          }
          continue;
        }

        // 366 = end of names list (we've joined)
        if (parsed.command === '366' && !sent) {
          socket.write(`PRIVMSG ${channel} :${text}\r\n`);
          setTimeout(() => done(true), 500);
          continue;
        }
      }
    });

    socket.on('error', (err) => {
      resolve({ ok: false, error: err.message });
    });
  });
}

/**
 * Get current users in a channel
 */
function ircUsers(channel) {
  return new Promise((resolve) => {
    const users = [];
    const nick = 'BritChatUsers' + Math.floor(Math.random() * 9000 + 1000);
    let timer;

    const socket = net.createConnection({ host: IRC_HOST, port: IRC_PORT });
    socket.setEncoding('utf8');

    const done = () => {
      clearTimeout(timer);
      try { socket.write(`QUIT\r\n`); socket.destroy(); } catch(e){}
      resolve({ ok: true, users, count: users.length });
    };

    timer = setTimeout(done, TIMEOUT_MS);

    let buffer = '';

    socket.on('connect', () => {
      socket.write(`NICK ${nick}\r\n`);
      socket.write(`USER britchat 0 * :BritChat\r\n`);
    });

    socket.on('data', (data) => {
      buffer += data;
      const lines = buffer.split('\r\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line) continue;
        if (line.startsWith('PING ')) { socket.write(`PONG ${line.slice(5)}\r\n`); continue; }

        const parsed = parseIRC(line);
        if (!parsed) continue;

        if (parsed.command === '001') {
          socket.write(`JOIN ${channel}\r\n`);
          continue;
        }

        if (parsed.command === '353') {
          parsed.trailing.split(' ').filter(Boolean).forEach(n => {
            const op = n.startsWith('@');
            const voice = n.startsWith('+');
            const clean = n.replace(/^[@+]/, '');
            if (clean) users.push({ nick: clean, op, voice });
          });
          continue;
        }

        if (parsed.command === '366') {
          done();
          return;
        }
      }
    });

    socket.on('error', () => resolve({ ok: false, users: [], count: 0 }));
  });
}

/**
 * Parse a raw IRC line into its components
 * Format: [:prefix] COMMAND [params] [:trailing]
 */
function parseIRC(line) {
  try {
    let prefix = null, nick = null, command, params = [], trailing = null;

    if (line.startsWith(':')) {
      const spaceIdx = line.indexOf(' ');
      prefix = line.slice(1, spaceIdx);
      line = line.slice(spaceIdx + 1);
      // Extract nick from prefix (nick!user@host)
      const excl = prefix.indexOf('!');
      nick = excl > 0 ? prefix.slice(0, excl) : prefix;
    }

    const colonIdx = line.indexOf(' :');
    if (colonIdx >= 0) {
      trailing = line.slice(colonIdx + 2);
      line = line.slice(0, colonIdx);
    }

    const parts = line.trim().split(/\s+/);
    command = parts[0];
    params = parts.slice(1);
    if (trailing !== null) params.push(trailing);

    return { prefix, nick, command, params, trailing };
  } catch(e) {
    return null;
  }
}

/**
 * Sanitise a BritChat username for IRC
 * IRC nicks: max 16 chars, start with letter, no spaces
 */
function sanitiseNick(name) {
  let n = name
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_\-\[\]\\`^{|}]/g, '')
    .slice(0, 16);
  // Must start with letter
  if (!/^[a-zA-Z]/.test(n)) n = 'BC_' + n;
  return n || 'BritChatUser';
}
