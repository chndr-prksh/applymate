// End-to-end check of the application tracker on the Workday-style fixture:
// fill -> submit -> tracked as applied -> reopening warns and does not fill ->
// "apply again" fills -> CSV export from the settings page.
import { chromium } from 'playwright';
import http from 'node:http';
import { readFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.env.OUT || path.join(root, 'test', 'out');
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok, detail = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);

const server = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(readFileSync(path.join(root, 'test/fixtures/workday.html'))));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/workday.html`;

const ctx = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'applymate-')), {
  ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : { channel: 'chromium' }),
  headless: true,
  viewport: { width: 1100, height: 800 },
  acceptDownloads: true,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
});
const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
await sw.evaluate((profile) => chrome.storage.local.set({ profile }), JSON.parse(readFileSync(path.join(root, 'profile.sample.json'), 'utf8')));
const apps = async () => Object.values((await sw.evaluate(() => chrome.storage.local.get('applications'))).applications || {});
const activeTab = () => sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id);
const reportCount = (id) => sw.evaluate((t) => (globalThis.__amReports[t] || []).length, id);

const first = await ctx.newPage();
await first.goto(url);
await sleep(9000);
check('first visit fills the form', (await first.inputValue('#legalNameSection_firstName')) === 'Alex');
check('tracked as started', (await apps())[0]?.status === 'started', (await apps())[0]?.title);
await first.getByText('Save and Continue').click();
await sleep(12000);
check('still only started before submit', (await apps())[0]?.status === 'started');
await first.getByText('Submit', { exact: true }).click();
await sleep(5000);
let [app] = await apps();
check('submit marks it applied', app?.status === 'applied' && app.times === 1, `${app?.company} / ${app?.title} / ${app?.appliedAt}`);
await first.screenshot({ path: path.join(out, 'tracker-applied.png') });

const again = await ctx.newPage();
await again.goto(url);
await again.bringToFront();
await sleep(6000);
const tab = await activeTab();
check('reopening does not fill', (await again.inputValue('#legalNameSection_firstName')) === '' && (await reportCount(tab)) === 0);
await again.screenshot({ path: path.join(out, 'tracker-warning.png') });

await sw.evaluate((t) => globalThis.__amApplyAgain(t), tab);
await sleep(4000);
check('apply again fills', (await again.inputValue('#legalNameSection_firstName')) === 'Alex');
await again.getByText('Save and Continue').click();
await sleep(12000);
await again.getByText('Submit', { exact: true }).click();
await sleep(8000);
[app] = await apps();
check('second submit counted', app?.times === 2 && (await apps()).length === 1, `times=${app?.times}`);

// Reopening after applying twice must warn again and stay unfilled.
const third = await ctx.newPage();
await third.goto(url);
await third.bringToFront();
await sleep(6000);
check('warns again after a second application', (await third.inputValue('#legalNameSection_firstName')) === '' && (await reportCount(await activeTab())) === 0);
await third.screenshot({ path: path.join(out, 'tracker-warning-again.png') });

const options = await ctx.newPage();
await options.goto(`chrome-extension://${new URL(sw.url()).host}/options/options.html`);
await sleep(500);
check('settings page lists it', (await options.locator('#apps tr').count()) === 2, (await options.locator('#apps tr').nth(1).innerText()).replace(/\s+/g, ' '));
const [download] = await Promise.all([options.waitForEvent('download'), options.click('#export')]);
const csv = readFileSync(await download.path(), 'utf8');
check('CSV export', csv.split('\r\n').length === 2 && csv.includes('"applied"'), csv.split('\r\n')[1]);
await options.locator('#apps').screenshot({ path: path.join(out, 'tracker-table.png') });

await ctx.close();
server.close();
