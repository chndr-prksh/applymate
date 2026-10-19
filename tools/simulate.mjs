// Same as tools/tailor.mjs but with the model's answers supplied from a file instead
// of the API, so prompts and layout can be reviewed without a key.
//   node tools/simulate.mjs --profile my-profile.json --responses responses.json [--out dir]
// responses.json: [{ "url": "<job url>", "name": "<file name>", "tailored": { ... } }]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tailorPdf } from '../src/tailor-run.js';
import { locateApplication } from '../src/location.js';
import { fetchJob, fileName, promptText } from './jobs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? null : args.splice(i, 2)[1]; };
const profile = JSON.parse(readFileSync(flag('--profile'), 'utf8'));
const responses = JSON.parse(readFileSync(flag('--responses'), 'utf8'));
const outDir = flag('--out') || path.join(root, 'tailored-resumes');
const originalPath = flag('--original');
const fonts = { regular: readFileSync(path.join(root, 'fonts/Carlito-Regular.woff')), bold: readFileSync(path.join(root, 'fonts/Carlito-Bold.woff')) };
mkdirSync(outDir, { recursive: true });

for (const r of responses) {
  const job = await fetchJob(r.url);
  const { bytes, fits, exact, bottom, requests } = await tailorPdf({ profile, job, location: (await locateApplication(job.location, profile, job.jd))?.label || '', ask: async () => r.tailored, fonts, original: originalPath && readFileSync(originalPath) });
  const name = r.name || fileName(job);
  writeFileSync(path.join(outDir, `${name}.pdf`), bytes);
  writeFileSync(path.join(outDir, `${name}.prompt.txt`), promptText(requests[0]));
  writeFileSync(path.join(outDir, `${name}.response.json`), JSON.stringify(r.tailored, null, 2));
  console.log(`${job.company}: ${job.title} | posting location: ${job.location} | ${!fits ? 'DOES NOT FIT' : exact ? 'fills the page exactly' : 'fits, lines differ from the original'}${bottom ? ` (last line at ${bottom.toFixed(0)}, limit 36)` : ''} -> ${name}.pdf`);
}
