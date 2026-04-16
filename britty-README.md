# BrittyBot Setup

## 1. Install
```bash
npm init -y
```

## 2. Set your OpenRouter key
```bash
export OPENROUTER_API_KEY=your_key_here
```
Or edit britty-bot.js line 22 and paste your key directly.

## 3. Run once to test
```bash
node britty-bot.js
```

## 4. Run 24/7 with PM2
```bash
npm install -g pm2
pm2 start britty-bot.js --name britty
pm2 save
pm2 startup   # auto-start on server reboot
```

## Commands BrittyBot responds to
- `!help` — shows available commands
- `!joke` — tells a random joke
- `!fact` — shares a random fact
- `!time` — shows UK time
- `!britchat` — promotes the site
- Mention "BrittyBot" or "Britty" in a message → AI response via OpenRouter

## Config options (top of britty-bot.js)
- `respondToAll: true` → Bot replies to every message with AI
- `keepAliveMs` → How often bot sends a message when room is quiet
- `model` → Change the OpenRouter model
