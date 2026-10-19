// The extension must stay silent on pages that are not job applications.
import { chromium } from 'playwright';
import http from 'node:http';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(readFileSync(path.join(root, 'test/fixtures/not-a-form.html'))));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'applymate-')), {
  ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : { channel: 'chromium' }),
  headless: true,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
});
const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
await sw.evaluate((d) => chrome.storage.local.set(d), {
  profile: JSON.parse(readFileSync(path.join(root, 'profile.sample.json'), 'utf8')),
  resume: { name: 'r.pdf', type: 'application/pdf', base64: readFileSync(path.join(root, 'test/fixtures/resume.pdf')).toString('base64') },
});
const base = `http://127.0.0.1:${server.address().port}`;
const live = (process.argv.slice(2).length ? process.argv.slice(2) : []).map((u) => [new URL(u).host, u]);
for (const [name, url] of [['mail compose with an attachment button', `${base}/mail`], ['job search page', `${base}/x?search`], ...live]) {
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.bringToFront();
  await new Promise((r) => setTimeout(r, 7000));
  const tab = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id);
  const reports = await sw.evaluate((t) => (globalThis.__amReports[t] || []).length, tab);
  // On live sites the page fills some of its own boxes, so only the test pages check field contents.
  const touched = await page.evaluate(() => (window.touched ? window.touched() : [])).catch(() => []);
  console.log(`${reports === 0 && !touched.length ? 'PASS' : 'FAIL'}  ${name}: fills started ${reports}, fields written ${JSON.stringify(touched)}`);
  await page.close();
}
await ctx.close();
server.close();
