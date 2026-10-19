// Checks that what the extension fills is accepted by forms that only register a
// value from the events a person produces, in a front tab and in a background tab.
import { chromium } from 'playwright';
import http from 'node:http';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(readFileSync(path.join(root, 'test/fixtures/strict.html'))));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/strict.html`;
const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'applymate-')), {
  ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : { channel: 'chromium' }),
  headless: true,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
});
const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
await sw.evaluate((profile) => chrome.storage.local.set({ profile }), JSON.parse(readFileSync(path.join(root, 'profile.sample.json'), 'utf8')));
const want = { firstName: 'Alex', lastName: 'Rivera', email: 'alex.rivera@example.com', city: 'San Francisco', travel: 'Yes', license: true };

for (const where of ['front tab', 'background tab', 'form that wipes itself 3 s after loading']) {
  const page = await ctx.newPage();
  await page.goto(where.startsWith('form') ? `${url}?late=1` : url);
  if (where === 'background tab') await (await ctx.newPage()).bringToFront();
  await new Promise((r) => setTimeout(r, 11000));
  const state = await page.evaluate(() => window.state);
  const missed = Object.keys(want).filter((k) => state[k] !== want[k]);
  console.log(`${missed.length ? 'FAIL' : 'PASS'}  ${where}: page registered ${Object.keys(want).length - missed.length} of ${Object.keys(want).length} answers${missed.length ? ` (missed: ${missed.join(', ')})` : ''}`);
}
await ctx.close();
server.close();
