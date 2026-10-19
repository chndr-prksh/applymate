// An application with no job description must wait and ask for it, then carry on by
// itself once the posting has been opened (here in another tab).
import { chromium } from 'playwright';
import http from 'node:http';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockClaude } from './mock-claude.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok, detail = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
const server = http.createServer((req, res) => {
  let body;
  try {
    body = readFileSync(path.join(root, 'test/fixtures', path.basename(req.url.split('?')[0])));
  } catch {
    return res.writeHead(404).end();
  }
  res.writeHead(200, { 'content-type': 'text/html' }).end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const mock = await startMockClaude();
const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'applymate-')), {
  ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : { channel: 'chromium' }),
  headless: true,
  viewport: { width: 1000, height: 700 },
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
});
const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
await sw.evaluate((d) => chrome.storage.local.set(d), {
  profile: JSON.parse(readFileSync(path.join(root, 'profile.sample.json'), 'utf8')),
  settings: { apiKey: 'test-key-not-real', baseUrl: mock.url, saveFiles: false },
  resume: { name: 'r.pdf', type: 'application/pdf', base64: readFileSync(path.join(root, 'test/fixtures/resume.pdf')).toString('base64') },
});

const form = await ctx.newPage();
await form.goto(`${base}/nojd.html`);
await sleep(9000);
check('waits when there is no job description', (await form.inputValue('#fn')) === '' && mock.calls.tailor === 0, `resume requests so far: ${mock.calls.tailor}`);
if (process.env.OUT) await form.screenshot({ path: path.join(process.env.OUT, 'need-job.png') });

const posting = await ctx.newPage();
await posting.goto(`${base}/jd.html`);
await sleep(12000);
check('carries on once the posting has been opened', (await form.inputValue('#fn')) === 'Alex');
check('the resume was tailored to that posting', mock.calls.tailor >= 1 && /ranking, relevance/.test(mock.calls.job || ''), (mock.calls.job || '').slice(0, 110));
check('the resume was attached', (await form.evaluate(() => document.querySelector('#cv').files.length)) === 1);

// Second case: the person pastes the posting link into the panel.
const before = mock.calls.tailor;
const form2 = await ctx.newPage();
await form2.goto(`${base}/nojd.html?second`);
await form2.bringToFront();
await sw.evaluate(async () => { await chrome.storage.session.remove(['recentJobs']); });
const tab2 = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id);
await sleep(4000);
const set = await sw.evaluate(([t, u]) => globalThis.__amSetJobLink(t, u), [tab2, `${base}/jd.html`]);
await sleep(12000);
check('a pasted posting link is read and used', set.ok && set.title === 'Senior Product Manager, Search', JSON.stringify(set));
if (process.env.DEBUG) console.log(JSON.stringify(await sw.evaluate(async (t) => ({ job: (await chrome.storage.session.get(`job:${t}`))[`job:${t}`]?.title, reports: (globalThis.__amReports[t] || []).map((r) => r.error || (r.rows || []).map((x) => x.status).join(',')) }), tab2)));
// (The same posting was tailored in the first case, so its resume is reused rather than rewritten.)
check('the form then fills and the tailored resume is attached', (await form2.inputValue('#fn')) === 'Alex' && (await form2.evaluate(() => document.querySelector('#cv').files.length)) === 1);

await ctx.close();
mock.close();
server.close();
