// Runs the extension's resume tailoring from the command line against the real API,
// so the prompt, the response and the PDF can be reviewed without filling a form.
//
//   ANTHROPIC_API_KEY=... node tools/tailor.mjs --profile my-profile.json <job url> [<job url> ...]
//
// For each job it writes into tailored-resumes/ (or --out): the PDF, the prompt that
// was sent (.prompt.txt) and what the model returned (.response.json).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callClaude } from '../src/claude.js';
import { costOf, tokensOf } from '../src/cost.js';
import { tailorPdf } from '../src/tailor-run.js';
import { locateApplication } from '../src/location.js';
import { fetchJob, fileName, promptText } from './jobs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? null : args.splice(i, 2)[1]; };
const profilePath = flag('--profile');
const outDir = flag('--out') || path.join(root, 'tailored-resumes');
const model = flag('--model') || 'claude-opus-5-5';
// --original: your own resume PDF; its pages after the first are carried over unchanged.
const originalPath = flag('--original');
if (!profilePath || !args.length) {
  console.error('Usage: ANTHROPIC_API_KEY=... node tools/tailor.mjs --profile my-profile.json <job url> [...]');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Set ANTHROPIC_API_KEY in your terminal first (it is read from the environment, never written anywhere).');
  process.exit(1);
}

const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
const fonts = { regular: readFileSync(path.join(root, 'fonts/Carlito-Regular.woff')), bold: readFileSync(path.join(root, 'fonts/Carlito-Bold.woff')) };
let spent = [];
const ask = async (request) => {
  const res = await callClaude({ apiKey: process.env.ANTHROPIC_API_KEY, baseURL: process.env.ANTHROPIC_BASE_URL, model, ...request });
  spent.push({ ...tokensOf(res.usage), cost: costOf(res.model, res.usage) });
  return res.data;
};
mkdirSync(outDir, { recursive: true });

for (const url of args) {
  const job = await fetchJob(url);
  process.stdout.write(`${job.company}: ${job.title} (${job.location || 'no location'}) ... `);
  const started = Date.now();
  spent = [];
  const { tailored, bytes, fits, exact, requests } = await tailorPdf({ profile, job, location: (await locateApplication(job.location, profile, job.jd))?.label || '', ask, fonts, original: originalPath && readFileSync(originalPath) });
  const name = fileName(job);
  writeFileSync(path.join(outDir, `${name}.pdf`), bytes);
  writeFileSync(path.join(outDir, `${name}.prompt.txt`), requests.map(promptText).join('\n\n########## FOLLOW-UP REQUEST (some pieces were the wrong length) ##########\n\n'));
  writeFileSync(path.join(outDir, `${name}.response.json`), JSON.stringify(tailored, null, 2));
  console.log(`${((Date.now() - started) / 1000).toFixed(1)} s, ${requests.length} request(s), ${!fits ? 'DOES NOT FIT the page' : exact ? 'fills the page exactly like the original' : 'fits, but some lines differ from the original'}, ${spent.reduce((n, s) => n + s.in, 0)} tokens in / ${spent.reduce((n, s) => n + s.out, 0)} out, about $${spent.reduce((n, s) => n + (s.cost || 0), 0).toFixed(4)} -> ${name}.pdf`);
}
