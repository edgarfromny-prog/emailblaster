const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// --- Supabase config ---
const supabaseUrl = 'https://aiqgbzptccziculqshub.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFpcWdi enB0Y2N6aWN1bHFzaHViIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDA1MDE5MDQsImV4cCI6MjA1NjA3NzkwNH0.UmKH_eh6I5t3X9J0vzKjY9nX8QcZ1Yb2L3mN4oP5rRs';
const supabase = createClient(supabaseUrl, supabaseKey);

// --- Telegram config ---
const TELEGRAM_BOT_TOKEN = '8748740739:AAF4OKti1yz67irs8Ph_iGDJN7DjHh6sVSs';
const TELEGRAM_CHAT_ID = '1903358250';

// --- Configuration ---
const ALLOWED_PATHS = new Set([
  '/t.gif',
  '/tracker.gif',
  '/pixel.gif',
  '/gif',
  '/1x1.gif'
]); // Add any paths you want to use for your tracking pixel

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

// Parse query parameters from URL
function parseQueryParams(url) {
  try {
    const queryString = url.split('?')[1] || '';
    const params = new URLSearchParams(queryString);
    return {
      user_id: params.get('user_id') || params.get('userId') || params.get('uid') || params.get('u') || 'unknown',
      company_name: params.get('company_name') || params.get('company') || params.get('c') || 'unknown',
      email: params.get('email') || params.get('e') || 'unknown'
    };
  } catch (e) {
    return {
      user_id: 'unknown',
      company_name: 'unknown',
      email: 'unknown'
    };
  }
}

// Store request in Supabase
async function storeInSupabase(req, params, ip, requestDump) {
  try {
    const { user_id, company_name, email } = params;
    
    if (user_id === 'unknown' || company_name === 'unknown' || email === 'unknown') {
      return;
    }

    // First, upsert the main email record
    const { data: emailData, error: emailError } = await supabase
      .from('emails')
      .upsert({
        user_id,
        company_name,
        email
      }, {
        onConflict: 'user_id, company_name, email',
        ignoreDuplicates: false
      })
      .select()
      .single();

    if (emailError) {
      console.error('[Supabase] Error upserting email:', emailError);
      return;
    }

    // Update opened_count and last_opened if record exists
    if (emailData) {
      await supabase
        .from('emails')
        .update({
          opened_count: (emailData.opened_count || 0) + 1,
          last_opened: new Date().toISOString()
        })
        .eq('id', emailData.id);
    }

    // Store the individual open record
    const { error: openError } = await supabase
      .from('email_opens')
      .insert({
        email_id: emailData?.id,
        user_id,
        company_name,
        email,
        ip,
        user_agent: req.headers['user-agent'] || 'unknown',
        request_dump: requestDump,
        opened_at: new Date().toISOString()
      });

    if (openError) {
      console.error('[Supabase] Error storing open:', openError);
    }

  } catch (e) {
    console.error('[Supabase] Unexpected error:', e);
  }
}

// Capture raw body early (only for allowed paths)
app.use((req, res, next) => {
  // Only capture body for allowed paths
  if (ALLOWED_PATHS.has(req.path)) {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      req.rawBody = Buffer.concat(chunks);
      next();
    });
  } else {
    next();
  }
});

// --- Strict path filtering - MUST come first ---
app.use((req, res, next) => {
  const path = req.path;
  
  // Check if this is an allowed tracking pixel path
  if (ALLOWED_PATHS.has(path)) {
    // This is a legitimate tracking request, process it
    next();
  } else {
    // Block all other requests silently - no logging, no Telegram, just 404
   
    res.status(404).send('Not Found');
  }
});

// --- Process legitimate tracking requests only ---
app.get('*', async (req, res) => {
  const timestamp = new Date().toISOString();
  const ip = req.headers['cf-connecting-ip'] || 
             req.headers['x-forwarded-for']?.split(',')[0].trim() || 
             req.headers['true-client-ip'] ||
             req.connection.remoteAddress || 
             'unknown';

  // Parse query parameters from URL
  const params = parseQueryParams(req.url);
  
  // Build request dump
  const requestDump = {
    timestamp,
    ip,
    method: req.method,
    path: req.path,
    query: req.query,
    headers: {
      'user-agent': req.headers['user-agent'],
      'referer': req.headers['referer'],
      'accept-language': req.headers['accept-language'],
      'cf-ipcountry': req.headers['cf-ipcountry']
    }
  };

  // Store in Supabase (background)
  if (params.user_id !== 'unknown' && params.company_name !== 'unknown' && params.email !== 'unknown') {
    storeInSupabase(req, params, ip, requestDump).catch(e => 
      console.error('[Supabase] Background error:', e)
    );
  }

  // Prepare Telegram report (only for valid tracking requests)
  let report = `*Email Open Detected*\n`;
  report += `*Path:* ${req.path}\n`;
  report += `*Company:* ${params.company_name}\n`;
  report += `*User ID:* ${params.user_id}\n`;
  report += `*Email:* ${params.email}\n`;
  report += `*Timestamp:* ${timestamp}\n`;
  report += `*IP:* ${ip}\n`;
  report += `*Country:* ${req.headers['cf-ipcountry'] || 'unknown'}\n`;
  
  if (req.headers['referer']) {
    report += `*Referer:* ${req.headers['referer']}\n`;
  }
  
  report += `*User-Agent:* ${req.headers['user-agent'] || 'unknown'}\n`;

  console.log(`[Tracker] ${req.path} from ${ip} - ${params.company_name}/${params.email}`);
  
  // Send to Telegram (async)
  telegramMessage(report).catch(() => {});
  
  // Serve the transparent GIF
  const TRANSPARENT_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(TRANSPARENT_GIF);
});

// --- Start server ---
const PORT = process.env.PORT || 80;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));