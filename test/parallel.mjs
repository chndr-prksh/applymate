// Opens several applications at once (only the last tab is in front) and checks
// that every one fills in the background, how long each took, and that an answer
// typed by hand is saved and passed to the AI on the next form.
//   node test/parallel.mjs <url> [<url> ...]
import { chromium } from 'playwright';
import http from 'node:http';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockClaude } from './mock-claude.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(readFileSync(path.join(root, 'test/fixtures/workday.html'))));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const fixture = `http://127.0.0.1:${server.address().port}/workday.html`;
const mock = await startMockClaude();

const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'applymate-')), {
  ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : { channel: 'chromium' }),
  headless: true,
  viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
});
const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
await sw.evaluate((data) => chrome.storage.local.set(data), {
  profile: JSON.parse(readFileSync(path.join(root, 'profile.sample.json'), 'utf8')),
  resume: { name: 'Alex_Rivera_Resume.pdf', type: 'application/pdf', base64: readFileSync(path.join(root, 'test/fixtures/resume.pdf')).toString('base64') },
  // WORKER_TIMERS=1 makes every tab wait the way a hidden tab does.
  settings: { apiKey: 'test-key-not-real', baseUrl: mock.url, workerTimers: !!process.env.WORKER_TIMERS },
});
const tabReports = () => sw.evaluate(async () => {
  const tabs = await chrome.tabs.query({});
  return tabs.map((t) => ({ url: t.url || '', active: t.active, reports: globalThis.__amReports[t.id] || [] }));
});

// --- Part 1: an answer typed by hand is saved, then offered to the AI ---------
const solo = await ctx.newPage();
await solo.goto(fixture);
await sleep(4000);
await solo.getByText('Save and Continue').click();
await sleep(4000);
await solo.click('#why', { clickCount: 3 });
await solo.keyboard.type('I like billing systems and small teams.');
await solo.keyboard.press('Tab');
await sleep(16000);
console.log('field still holds what was typed:', (await solo.inputValue('#why')) === 'I like billing systems and small teams.');
const saved = (await sw.evaluate(() => chrome.storage.local.get('answers'))).answers || {};
console.log('saved by hand:', JSON.stringify(Object.values(saved).map((e) => `${e.q} => ${e.a}`)));
await solo.close();

// --- Part 2: many tabs at once ------------------------------------------------
const urls = process.argv.slice(2);
const t0 = Date.now();
const pages = [];
for (const u of urls) {
  const p = await ctx.newPage();
  p.goto(u, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  pages.push(p);
}
let state = [];
for (let i = 0, stable = 0; i < 90 && stable < 5; i++) {
  await sleep(1000);
  const now = await tabReports();
  const done = (t) => t.reports.length && !t.reports.at(-1).rows?.some((r) => r.status === 'working');
  const all = urls.every((u) => now.some((t) => t.url.split('?')[0].startsWith(u.split('?')[0].slice(0, 40)) && done(t)));
  stable = all && JSON.stringify(now.map((t) => t.reports.length)) === JSON.stringify(state.map((t) => t.reports.length)) ? stable + 1 : 0;
  state = now;
}
const hidden = await Promise.all(pages.map((p) => p.evaluate(() => document.hidden).catch(() => '?')));
console.table(state.filter((t) => t.reports.length && t.url).map((t) => {
  const last = new Map(t.reports.map((r) => [r.frame, r]));
  const rows = [...last.values()].flatMap((r) => r.rows || []);
  const by = (...s) => rows.filter((r) => s.includes(r.status)).length;
  return { site: new URL(t.url).host, inFront: t.active, fields: rows.length, filled: by('filled', 'review'), forYou: by('needs', 'manual'), failed: by('failed'), fillSeconds: +(Math.max(...t.reports.map((r) => r.ms || 0)) / 1000).toFixed(1) };
}));
console.log(`tabs reporting hidden: ${hidden.filter((h) => h === true).length} of ${pages.length}; wall time ${((Date.now() - t0) / 1000).toFixed(0)}s (includes a 5s settle wait)`);
console.log(`AI requests: ${mock.calls.map} answer batches, ${mock.calls.tailor} resumes`);
console.log('previous answers sent to AI:', mock.calls.previous);
console.log(`models used: answers=${mock.calls.answerModel}, resume=${mock.calls.resumeModel}`);
await ctx.close();
mock.close();
server.close();
