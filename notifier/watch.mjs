// Concrete Dispatching — notifier.
// Runs on a schedule (.github/workflows/notify.yml). Opens the live app as "?bot=1" in a headless browser,
// reads the same Data checks the screen shows (window.__notifyItems) and pushes the ones not sent before
// to every device that pressed "Enable notifications". The app itself decides what a check is — there is
// no second copy of the rules here.
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import webpush from 'web-push';

const APP   = 'https://elkady591.github.io/Concrete-Dispatching/';
const OPEN  = 'https://elkady591.github.io/Concrete-Management/#dispatching';   // where a tapped notification lands
const SYNC  = 'https://script.google.com/macros/s/AKfycbzEusaa09hNFjfsRiwaZdp-jLwLsbqGAdfKhpwovAjqaV_uxr34F5-nNGVXI8L0dUBB/exec';
const PUB   = 'BNkjRt73PZvPzps_8XHXpdkUlIQN3YDQC_61OCwZWqqEhB4WwXEGpgZXifVCqq20jAWqEQiRF0Uz-BhR-2ztFVQ';
const PRIV  = process.env.VAPID_PRIVATE_KEY || '';
const TEST  = process.env.NOTIFY_TEST === '1';
const STATE = './state/sent.json';
const KEEP_MS = 4 * 86400000;      // forget ids older than this
const MAX_SEPARATE = 4;            // more new checks than this in one run -> one summary note

const TITLES = { 'No ES': 'Truck without ES', 'Rejected': 'Rejected truck', 'Late trucks': 'Late trucks',
                 'Gaps': 'Long gap between trucks', 'Overdue now': 'No truck — overdue now' };

if (!PRIV) { console.log('VAPID_PRIVATE_KEY secret is not set — nothing sent.'); process.exit(0); }
webpush.setVapidDetails(APP, PUB, PRIV);

async function subscribers() {
  const r = await fetch(SYNC + '?action=pushlist', { redirect: 'follow' });
  const j = await r.json();
  if (!j.ok) throw new Error('pushlist failed');
  return j.subs || [];
}
async function send(subs, payload) {
  let ok = 0;
  for (const s of subs) {
    try { await webpush.sendNotification(JSON.parse(s.sub), JSON.stringify(payload), { TTL: 3600, urgency: 'high' }); ok++; }
    catch (e) {
      console.log(`  push to ${s.dev} failed: ${e.statusCode || e.message}`);
      if (e.statusCode === 404 || e.statusCode === 410)      // the device unsubscribed / reinstalled: drop it
        await fetch(SYNC + '?action=pushdel&dev=' + encodeURIComponent(s.dev)).catch(() => {});
    }
  }
  return ok;
}

const subs = await subscribers();
console.log(`devices subscribed: ${subs.length}`);

if (TEST) {
  const n = await send(subs, { title: 'Concrete Dispatching', body: 'Test from the notifier — alerts will arrive like this.', tag: 'test', url: OPEN });
  console.log(`test sent to ${n} device(s)`);
  process.exit(0);
}

// ---- read the app's own Data checks ----
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
let items = [], build = '';
try {
  const page = await browser.newPage();
  await page.emulateTimezone('Africa/Cairo');               // "today" must be the plant's day, not the runner's (UTC)
  await page.goto(APP + '?bot=1&t=' + Date.now(), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__ready && typeof window.__notifyItems === 'function', { timeout: 90000 });
  items = await page.evaluate(() => window.__notifyItems());
  build = await page.evaluate(() => (document.querySelector('meta[name="app-build"]') || {}).content || '');
} catch (e) {
  // the sheet or the page did not answer in time: skip this round quietly (the next run tries again) —
  // a failed run would only make GitHub e-mail the owner every few minutes
  console.log('could not read the app this round: ' + e.message);
  await browser.close();
  process.exit(0);
} finally { await browser.close().catch(() => {}); }
console.log(`app build ${build}: ${items.length} check(s) on screen`);

// ---- which of them are new? ----
let state = null;
try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) {}
const first = !state;                                       // very first run: remember what is there, send nothing
const sent = (state && state.sent) || {};
const now = Date.now();
const fresh = items.filter(it => it.ids.some(id => !sent[id]));
for (const it of items) for (const id of it.ids) if (!sent[id]) sent[id] = now;
for (const id in sent) if (now - sent[id] > KEEP_MS) delete sent[id];
fs.mkdirSync('./state', { recursive: true });
fs.writeFileSync(STATE, JSON.stringify({ sent, at: now }));

if (first) { console.log(`first run — ${items.length} existing check(s) noted, nothing sent`); process.exit(0); }
if (!fresh.length) { console.log('nothing new'); process.exit(0); }

console.log(`${fresh.length} new:`); fresh.forEach(it => console.log(`  [${it.kind}] ${it.text}`));
if (fresh.length > MAX_SEPARATE) {
  const kinds = [...new Set(fresh.map(it => TITLES[it.kind] || it.kind))].join(', ');
  await send(subs, { title: `${fresh.length} new checks`, body: kinds + ' — open the app to review.', tag: 'many-' + now, url: OPEN });
} else {
  for (const it of fresh)
    await send(subs, { title: TITLES[it.kind] || ('Check: ' + it.kind), body: it.text, tag: it.ids[0], url: OPEN });
}
