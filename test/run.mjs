// Loads the unpacked extension in Chromium, opens each URL, lets the extension fill
// the form on its own, and prints what happened to every field. Nothing is submitted.
//   node test/run.mjs <url> [<url> ...]      (env: OUT=dir for screenshots, HEADED=1, MOCK_AI=1)
import { chromium } from 'playwright';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { startMockClaude, startMockOllama } from './mock-claude.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.env.OUT || path.join(root, 'test', 'out');
mkdirSync(out, { recursive: true });
const urls = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = JSON.parse(readFileSync(process.env.PROFILE || path.join(root, 'profile.sample.json'), 'utf8'));
const resume = { name: 'Alex_Rivera_Resume.pdf', type: 'application/pdf', base64: readFileSync(path.join(root, 'test/fixtures/resume.pdf')).toString('base64') };
const settings = {};
let mock;
if (process.env.MOCK_AI) {
  mock = await startMockClaude();
  Object.assign(settings, { apiKey: 'test-key-not-real', baseUrl: mock.url });
}
// LOCAL_AI=1: form questions go to a stand-in Ollama, the resume still to the Claude stand-in.
const ollama = process.env.LOCAL_AI ? await startMockOllama() : null;
if (ollama) Object.assign(settings, { answerProvider: 'local', localUrl: ollama.url, localModel: 'qwen2.5:3b' });

const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'applymate-')), {
  // CHROMIUM=path reuses an already-downloaded build instead of Playwright's default.
  ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : { channel: 'chromium' }),
  headless: !process.env.HEADED,
  viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
});
const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
await sw.evaluate((data) => chrome.storage.local.set(data), { profile, resume, settings });

// "fixture:name.html" is served from test/fixtures on localhost.
const fixtures = http.createServer((req, res) => {
  let body;
  try {
    body = readFileSync(path.join(root, 'test/fixtures', path.basename(req.url.split('?')[0])));
  } catch {
    return res.writeHead(404).end();
  }
  res.writeHead(200, { 'content-type': 'text/html' }).end(body);
});
await new Promise((r) => fixtures.listen(0, '127.0.0.1', r));

const summary = [];
for (const arg of urls) {
  // "url|Apply|Next" clicks Apply before the first page (leave empty to skip), then
  // Next before each further page of a multi-step form.
  const [target, click, ...nexts] = arg.split('|');
  const url = target.replace(/^fixture:/, `http://127.0.0.1:${fixtures.address().port}/`);
  const base = target.startsWith('fixture:') ? target.slice(8) : new URL(url).hostname.replace(/^www\./, '');
  const page = await ctx.newPage();
  const atStart = mock && { ...mock.calls };
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(6000);
    if (click) {
      await page.locator('a,button').filter({ hasText: new RegExp(click, 'i') }).first().click();
      await sleep(4000);
    }
    await page.bringToFront();
   for (const [step, next] of [null, ...nexts].entries()) {
    const name = step ? `${base}.step${step + 1}` : base;
    const before = step ? mock && { ...mock.calls } : atStart;
    if (next) await page.locator('a,button').filter({ hasText: new RegExp(next, 'i') }).first().click();
    const seen = step ? (await sw.evaluate(async () => { const id = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id; return (globalThis.__amReports[id] || []).length; })) : 0;
    if (process.env.PRE) await page.screenshot({ path: path.join(out, `${base}.before.png`) });
    const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id);

    let reports = [], stable = 0;
    for (let i = 0; i < 90 && stable < 6; i++) {
      await sleep(1000);
      const now = await sw.evaluate((id) => globalThis.__amReports[id] || [], tabId);
      const settled = now.length > seen && !now.at(-1).rows?.some((r) => r.status === 'working');
      stable = settled && now.length === reports.length ? stable + 1 : 0;
      reports = now;
    }
    // Each frame reports progressively; its last report is the final state.
    const last = new Map(reports.map((r) => [r.frame, r]));
    const rows = [...last.values()].flatMap((r) => r.rows || []);
    if (mock) {
      console.log(`\n   AI requests for this page: ${mock.calls.map - before.map} answers (${mock.calls.fields - before.fields} questions), ${mock.calls.choose - before.choose} dropdown picks, ${mock.calls.tailor - before.tailor} resume; job description sent: ${mock.calls.sawJob}`);
      const pdfs = await sw.evaluate(async () => Object.entries(await chrome.storage.session.get(null)).filter(([k]) => k.startsWith('tailored:')).map(([, v]) => v.base64));
      if (pdfs.length) writeFileSync(path.join(out, `${name}.tailored.pdf`), Buffer.from(pdfs.at(-1), 'base64'));
      const log = (await sw.evaluate(() => chrome.storage.local.get('promptLog'))).promptLog || [];
      console.log(`   prompt log: ${log.length} entries (${log.map((e) => `${e.use}/${e.model} ${e.tokens?.in ?? '?'} tokens in`).join(', ')})`);
    }
    const errors = reports.filter((r) => r.error).map((r) => r.error);
    const by = (s) => rows.filter((r) => r.status === s).length;
    console.log(`\n=== ${name}  (${page.url()})`);
    for (const e of errors) console.log(`  ERROR ${e}`);
    for (const r of rows) console.log(`  ${r.status.padEnd(7)} ${r.kind.padEnd(10)} ${(r.source || '').padEnd(7)} ${r.required ? '*' : ' '} ${r.label.slice(0, 60).padEnd(60)} ${(r.value || r.note || '').slice(0, 70)}`);
    summary.push({ name, fields: rows.length, filled: by('filled'), review: by('review'), needs: by('needs') + by('manual'), failed: by('failed'), kept: by('kept') });
    writeFileSync(path.join(out, `${name}.json`), JSON.stringify(rows, null, 1));
    await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true }).catch(() => {});
   }
  } catch (e) {
    console.log(`\n=== ${base}\n  HARNESS ERROR ${e.message}`);
    summary.push({ name: base, error: e.message.split('\n')[0] });
  }
  await page.close();
}
console.log('');
console.table(summary);
await ctx.close();
mock?.close();
if (ollama) console.log(`local model requests: ${ollama.calls.chat} (model ${ollama.calls.model}), ${ollama.calls.promptChars} characters sent`);
ollama?.close();
fixtures.close();
