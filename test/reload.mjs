// A form that reloads itself when a dropdown changes or a resume is uploaded must be
// filled once, not over and over.
import { chromium } from 'playwright';
import http from 'node:http';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(readFileSync(path.join(root, 'test/fixtures/reload.html'))));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'applymate-')), {
  ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : { channel: 'chromium' }),
  headless: true,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
});
const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
await sw.evaluate((d) => chrome.storage.local.set(d), {
  profile: JSON.parse(readFileSync(path.join(root, 'profile.sample.json'), 'utf8')),
  resume: { name: 'Alex_Rivera_Resume.pdf', type: 'application/pdf', base64: readFileSync(path.join(root, 'test/fixtures/resume.pdf')).toString('base64') },
});
const page = await ctx.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/reload.html`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const snap = async () => { for (;;) { try { return await page.evaluate(() => window.snapshot()); } catch { await sleep(300); } } };
await sleep(15000);
const a = await snap();
await sleep(10000);
const b = await snap();
const filled = b.fn === 'Alex' && b.ln === 'Rivera' && b.em === 'alex.rivera@example.com' && b.ci === 'San Francisco' && b.co === 'United States' && !!b.resume;
console.log(`${b.loads === a.loads ? 'PASS' : 'FAIL'}  page stopped reloading (loads after 15 s: ${a.loads}, after 25 s: ${b.loads})`);
console.log(`${b.loads <= 3 ? 'PASS' : 'FAIL'}  reloaded at most once per reloading field (${b.loads - 1} reloads for 2 such fields)`);
console.log(`${filled ? 'PASS' : 'FAIL'}  everything still got filled  ${JSON.stringify(b)}`);
await ctx.close();
server.close();
