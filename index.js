// index.js
// TikTok Live Notifier → Telegram (Node.js + Playwright)
// by: you :)

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { chromium } = require('playwright');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const INTERVAL = Number(process.env.POLL_INTERVAL_MS || 120000); // default 2 menit
const TZ = process.env.TZ || 'Asia/Jakarta';

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('ERROR: BOT_TOKEN dan CHAT_ID wajib di-set (env).');
  process.exit(1);
}

// ---------- utils: state persist (opsional) ----------
const STATE_FILE = path.join(__dirname, 'lastState.json');
function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return new Map(JSON.parse(raw));
  } catch {
    return new Map();
  }
}
function saveState(map) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(Array.from(map.entries())));
  } catch {
    // railway fs bisa read-only saat build; saat run-time biasanya ok. Abaikan error.
  }
}
const lastState = loadState();

// ---------- load accounts ----------
let accounts = [];
try {
  const raw = fs.readFileSync(path.join(__dirname, 'accounts.json'), 'utf8');
  accounts = JSON.parse(raw).filter(Boolean);
} catch (e) {
  console.error('ERROR: Gagal baca accounts.json. Pastikan file ada dan valid JSON.');
  process.exit(1);
}
if (accounts.length === 0) {
  console.error('ERROR: accounts.json kosong.');
  process.exit(1);
}

// ---------- telegram ----------
async function sendTelegram(text, opts = {}) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...opts,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) {
    console.error('Telegram error:', data);
  }
}

// ---------- detector ----------
async function checkLiveStatus(page, username) {
  const profileUrl = `https://www.tiktok.com/@${username}`;
  const liveUrl = `https://www.tiktok.com/@${username}/live`;

  await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1500);

  // Coba baca data ter-embed (SIGI_STATE/script)
  const info = await page.evaluate(() => {
    const out = {
      live: false,
      roomId: null,
      title: null,
      viewerCount: null,
    };

    try {
      // 1) TikTok sering menaruh JSON di <script id="SIGI_STATE">...</script>
      const el = document.querySelector('#SIGI_STATE');
      if (el && el.textContent) {
        const state = JSON.parse(el.textContent);
        // Cari info live dari state (struktur bisa berubah; ini pattern umum)
        // Mencari roomId dan title yang sering ada di fields "LiveRoom"/"RoomData"
        const s = JSON.stringify(state);
        const mRoom = s.match(/"roomId":"?(\d{8,})"?/);
        if (mRoom) out.roomId = mRoom[1];

        // title (kadang "title":"...") dan viewer_count (viewerCount/user_count)
        const mTitle = s.match(/"title":"([^"]{1,200})"/);
        if (mTitle) out.title = mTitle[1];

        const mViewer =
          s.match(/"viewerCount":\s?(\d+)/) ||
          s.match(/"user_count":\s?(\d+)/) ||
          s.match(/"audienceCount":\s?(\d+)/);
        if (mViewer) out.viewerCount = Number(mViewer[1]);

        if (out.roomId) out.live = true;
      }
    } catch (e) {
      // ignore
    }

    return out;
  });

  // Fallback: badge "LIVE" di UI (kalau roomId tidak ditemukan)
  if (!info.live) {
    try {
      const hasLiveBadge = await page.locator('text=LIVE').first().isVisible({ timeout: 1000 });
      if (hasLiveBadge) info.live = true;
    } catch {
      // ignore
    }
  }

  return {
    username,
    live: info.live,
    roomId: info.roomId || null,
    title: info.title || null,
    viewerCount: info.viewerCount || null,
    profileUrl,
    liveUrl,
  };
}

// ---------- main loop ----------
async function run() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    // UA & viewport ringan anti-block ringan
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    timezoneId: TZ,
  });
  const page = await context.newPage();

  console.log(
    `[${new Date().toLocaleString('id-ID', { timeZone: TZ })}] Monitoring ${accounts.length} akun tiap ${Math.round(
      INTERVAL / 1000
    )} detik...`
  );

  async function tick() {
    for (const username of accounts) {
      try {
        const status = await checkLiveStatus(page, username);
        const prev = lastState.get(username) || { live: false, roomId: null };

        if (status.live && !prev.live) {
          // Transisi OFF -> ON → kirim notif
          const lines = [
            '🔴 <b>' + username + '</b> sedang LIVE!',
            status.title ? `Judul: ${escapeHtml(status.title)}` : null,
            status.viewerCount != null ? `Penonton: ${status.viewerCount.toLocaleString('id-ID')}` : null,
            `Tonton: ${status.liveUrl}`,
            `Profil: ${status.profileUrl}`,
            `Jam: ${new Date().toLocaleString('id-ID', { timeZone: TZ })}`,
          ].filter(Boolean);
          await sendTelegram(lines.join('\n'));
        }
        // (Opsional) Kirim notif saat ON -> OFF:
        // else if (!status.live && prev.live) {
        //   await sendTelegram(`⚫ <b>${username}</b> telah selesai LIVE.\nJam: ${new Date().toLocaleString('id-ID',{ timeZone: TZ })}`);
        // }

        lastState.set(username, { live: status.live, roomId: status.roomId });
      } catch (e) {
        console.error(`[${username}] error:`, e.message);
      }

      // Jeda antar akun biar gak agresif
      await delay(2000);
    }

    // persist state
    saveState(lastState);
  }

  // Jalan pertama kali + interval
  await tick();
  setInterval(tick, INTERVAL);
}

// ---------- helpers ----------
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------- test flag ----------
if (process.argv.includes('--test')) {
  (async () => {
    try {
      await sendTelegram('✅ Bot OK: test notifikasi (--test)\nJam: ' + new Date().toLocaleString('id-ID', { timeZone: TZ }));
      console.log('Test message sent.');
      process.exit(0);
    } catch (e) {
      console.error('Test failed:', e);
      process.exit(1);
    }
  })();
} else {
  run().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
