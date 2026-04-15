/**
 * BritChat IRC Bridge
 * Sends messages to IRC on behalf of BritChat users
 * Pure CommonJS - works with Vercel Node.js runtime
 */

const net = require('net');

const IRC_HOST = 'irc.icq-chat.com';
const IRC_PORT = 6667;
const FB = 'https://britchat-6faa5-default-rtdb.firebaseio.com';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let body = '';
  try {
    for await (const chunk of req) body += chunk;
  } catch(e) { return res.status(400).json({ ok: false, error: 'Bad request' }); }

  let params = {};
  try { params = JSON.parse(body); } catch(e) {}

  const action  = params.action  || 'send';
  const channel = params.channel || '#Chat';
  const nick    = (params.nick   || 'BritChatUser').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 12);
  const text    = (params.text   || '').slice(0, 400);
  const avatar  = params.avatar  || '💬';
  const color   = params.color   || '#50cc50';

  if (!text) return res.status(400).json({ ok: false, error: 'No text' });

  const ircNick = 'BC_' + nick;

  // Send to IRC
  const sent = await sendIRCMessage(ircNick, channel, text);

  // Always save to Firebase so BritChat users see it immediately
  const fbPath = channelToPath(channel);
  const msg = {
    nick: params.displayName || nick,
    ircNick,
    text,
    ts: Date.now(),
    channel,
    fromBritChat: true,
    avatar,
    color,
  };

  try {
    await fetch(`${FB}/bc_irc/${fbPath}.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg),
    });
  } catch(e) {}

  return res.status(200).json({ ok: true, sent, ircNick });
};

function channelToPath(channel) {
  const map = { '#Chat': 'irc_chat', '#ICQchat': 'irc_icqchat', '#English': 'irc_english' };
  return map[channel] || 'irc_chat';
}

function sendIRCMessage(nick, channel, text) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch(e) {}
      resolve(result);
    };

    const timer = setTimeout(() => finish(false), 9000);

    let buf = '';
    let registered = false;
    let joined = false;

    const socket = net.createConnection({ host: IRC_HOST, port: IRC_PORT });

    socket.on('connect', () => {
      socket.write(`NICK ${nick}\r\nUSER britchat 0 * :BritChat\r\n`);
    });

    socket.on('data', (data) => {
      buf += data.toString('utf8');
      const lines = buf.split('\r\n');
      buf = lines.pop();

      for (const line of lines) {
        if (line.startsWith('PING')) {
          socket.write('PONG ' + line.slice(5) + '\r\n');
          continue;
        }
        // 001 = registered
        if (!registered && line.includes(' 001 ')) {
          registered = true;
          socket.write(`JOIN ${channel}\r\n`);
        }
        // 433 = nick in use
        if (line.includes(' 433 ')) {
          const newNick = nick.slice(0, 14) + Math.floor(Math.random() * 9);
          socket.write(`NICK ${newNick}\r\n`);
        }
        // 366 = end of /NAMES = fully joined
        if (!joined && line.includes(' 366 ')) {
          joined = true;
          socket.write(`PRIVMSG ${channel} :${text}\r\n`);
          setTimeout(() => {
            socket.write('QUIT :BritChat\r\n');
            setTimeout(() => finish(true), 400);
          }, 300);
        }
      }
    });

    socket.on('error', () => finish(false));
    socket.on('close', () => { if (!done) finish(false); });
  });
}
