// Service worker: relays messages between frames and the panel, and owns every
// call to Claude so the API key never touches a web page.
import { callClaude } from './claude.js';
import { callLocal } from './local.js';
import { costOf, tokensOf } from './cost.js';
import { fetchPostingPage, lookupJob, looksLikePosting } from './jobs.js';
import { locateApplication } from './location.js';
import { tailorPdf } from './tailor-run.js';

// Form questions are short and frequent, so they go to the fastest, cheapest model.
// The resume is written once per job and is what the employer reads, so it gets the best.
const DEFAULT_MODELS = { answers: 'claude-haiku-4-5', resume: 'claude-opus-5-5' };

const MAP_SYSTEM = `Fill a job application form for one person. Return a value for each field from their profile; they review everything before submitting.

- Use only the profile, the person's earlier answers and the job description. Never invent employers, degrees, dates, certifications or tool experience. If nothing supports an answer, return empty "values".
- With "options", copy one option exactly (several only for kind "checkboxes"); if none is clearly true, return empty. A field marked "long_list" has too many options to show: give the plain text to search for (a school, a city, a degree).
- Kinds: "combobox" without options = searchable list, give short text; "number" = digits only, within min/max (a 1-5 rating wants the number); "date" = YYYY-MM-DD or YYYY-MM; "checkbox" = "Yes" to tick, else empty.
- Essays: first person, in the person's voice, specific to their resume and this job, within max_length, no filler.
- Visa questions: answer the meaning, not the keyword. eligible_where_job_is true = authorized wherever the job is; sponsorship false = needs none now or later. So "authorized to work here?" Yes, "require sponsorship?" No, "can you work without sponsorship?" Yes.
- "address" is the application's location (for location fields); "home_address", if present, is where they live (for "where are you based" and relocation questions; mark those not confident).
- "earlier" lists answers they typed on past applications: reuse one when a field asks the same thing differently.

Set "confident" false for anything inferred or drafted. One entry per field id.`;

const MAP_SCHEMA = {
  type: 'object',
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          values: { type: 'array', items: { type: 'string' } },
          confident: { type: 'boolean' },
        },
        required: ['id', 'values', 'confident'],
        additionalProperties: false,
      },
    },
  },
  required: ['answers'],
  additionalProperties: false,
};

const str = { type: 'string' };
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const RESUME_SCHEMA = obj({
  first_name: str, last_name: str, email: str, phone: str,
  address: obj({ line1: str, city: str, state: str, postal_code: str, country: str }),
  links: obj({ linkedin: str, github: str, portfolio: str, twitter: str }),
  current_company: str, current_title: str, years_experience: str, summary: str,
  skills: { type: 'array', items: str },
  education: { type: 'array', items: obj({ school: str, degree: str, field: str, start: str, end: str, gpa: str }) },
  experience: { type: 'array', items: obj({ company: str, title: str, location: str, start: str, end: str, current: { type: 'boolean' }, description: str }) },
  resume_text: str,
});

const RESUME_SYSTEM = `Extract a job applicant's details from their resume into the given structure. Copy what the resume says; use an empty string or empty list for anything it does not state rather than guessing. Dates as YYYY-MM. "years_experience" is total professional experience as a whole number, computed from the work history. "resume_text" is the full resume as plain text, which later answers will be grounded in.`;

// Every request and what came back is kept (the last 40), so prompts can be reviewed
// and tuned from the settings page. Attached files are noted, not stored.
async function logPrompt(entry) {
  const flat = (x) => (typeof x === 'string' ? x : [].concat(x).map((b) => b.text ?? `[${b.type}]`).join('\n\n'));
  const { promptLog = [] } = await chrome.storage.local.get('promptLog');
  promptLog.unshift({ ...entry, system: flat(entry.system), content: flat(entry.content) });
  await chrome.storage.local.set({ promptLog: promptLog.slice(0, 40) });
}

async function ask({ system, content, schema, use, about, tabId }) {
  const { settings = {} } = await chrome.storage.local.get('settings');
  // Form questions can go to a model on this computer instead; the resume always uses Claude.
  const local = use === 'answers' && settings.answerProvider === 'local';
  if (!local && !settings.apiKey) throw new Error('Add your Anthropic API key in settings.');
  const model = local ? settings.localModel || 'qwen2.5:3b' : (use === 'answers' ? settings.answerModel : settings.resumeModel) || DEFAULT_MODELS[use];
  const started = Date.now();
  const entry = { at: new Date().toISOString(), use, about: about || '', model, system, content };
  try {
    const res = local
      ? await callLocal({ url: settings.localUrl || 'http://localhost:11434', model, system, content, schema })
      : await callClaude({ apiKey: settings.apiKey, baseURL: settings.baseUrl, model, fast: settings.fast, system, content, schema });
    const cost = local ? 0 : costOf(res.model, res.usage, settings.fast);
    logPrompt({ ...entry, model: res.model, seconds: (Date.now() - started) / 1000, response: res.data, tokens: tokensOf(res.usage), cost });
    addCost(tabId, cost);
    return res.data;
  } catch (e) {
    logPrompt({ ...entry, seconds: (Date.now() - started) / 1000, error: e.message });
    throw e;
  }
}

const session = chrome.storage.session;
const read = async (area, key) => (await area.get(key))[key];

// The job the person is applying to, captured from the description page and kept
// per tab so the application form (often a later page or an iframe) can use it.
const lookups = new Map();

async function getJob(tabId, waitMs = 0) {
  // If the posting is still being looked up, give that a moment to finish.
  if (waitMs && lookups.has(tabId)) await Promise.race([lookups.get(tabId), new Promise((r) => setTimeout(r, 4000))]);
  // A form in an iframe can ask before the top page has reported its description.
  for (const end = Date.now() + waitMs; ; ) {
    const job = await read(session, `job:${tabId}`);
    if (job || Date.now() >= end) return job;
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function noteJob(tabId, msg) {
  const cur = await getJob(tabId);
  const sameSite = cur && new URL(cur.url).origin === new URL(msg.url).origin;
  // A form page on the same site (or one with no description of its own) is a later
  // step of the same application; keep the description already captured.
  if (sameSite && cur.jd && (msg.fields >= 3 || !msg.jd) && cur.url !== msg.url) return;
  // source: 'listing' (the board's own data), 'structured' (posting data in the page),
  // or 'page' (text read off the page, which may be a careers page rather than a posting).
  const job = { url: msg.url, title: msg.title, company: msg.company, location: msg.location || '', jd: msg.jd, source: msg.structured ? 'structured' : 'page', postingLike: !!msg.postingLike };
  await session.set({ [`job:${tabId}`]: job });
  remember(job);
  // Greenhouse and Workday publish each posting as data, which is more reliable than
  // reading the page and works from any step of the application.
  const lookup = lookupJob(msg.url, msg.hints || [])
    .then(async (found) => {
      if (!found) return;
      Object.assign(job, { title: found.title || job.title, company: found.company || job.company, location: found.location || job.location, jd: found.jd.length > 400 ? found.jd : job.jd, source: found.jd.length > 400 ? 'listing' : job.source });
      await session.set({ [`job:${tabId}`]: job });
      remember(job);
    })
    .catch(() => {})
    .finally(() => lookups.get(tabId) === lookup && lookups.delete(tabId));
  lookups.set(tabId, lookup);
}

const usable = (job) => !!job?.jd && (job.source !== 'page' || job.postingLike || looksLikePosting(job.jd));
// Regenerate the candidate brief in the background whenever the profile or saved answers change.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.profile || changes.answers)) setTimeout(() => candidateBrief().catch(() => {}), 15000);
});

// Postings seen recently in any tab, so an application opened in a new tab or reached
// by a different address can still be matched to the description read a moment ago.
async function remember(job) {
  if (!usable(job)) return;
  const recent = ((await read(session, 'recentJobs')) || []).filter((r) => r.url !== job.url);
  await session.set({ recentJobs: [{ ...job, at: Date.now() }, ...recent].slice(0, 15) });
  // Tabs waiting for a description can carry on.
  for (const tab of await chrome.tabs.query({})) toTab(tab.id, { type: 'job-found' });
}

const idsIn = (url) => new Set(String(url).match(/\d{5,}|[0-9a-f]{8}-[0-9a-f-]{27}/gi) || []);

// The job description for the application in this tab, found by every means
// available, or null when there is none and the person has to point to it.
async function ensureJob(tab) {
  let job = await getJob(tab.id, 3000);
  if (usable(job)) return job;
  const adopt = async (found, source) => {
    job = { url: job?.url || tab.url, title: found.title || job?.title || tab.title || '', company: found.company || job?.company || '', location: found.location || job?.location || '', jd: found.jd, source };
    await session.set({ [`job:${tab.id}`]: job });
    remember(job);
    return job;
  };
  // 1. The board's public listing, straight from this tab's address.
  const listed = await lookupJob(tab.url).catch(() => null);
  if (listed) return adopt(listed, 'listing');
  // 2. The description page behind this application address.
  const page = await fetchPostingPage(tab.url).catch(() => null);
  if (page) return adopt(page, page.structured ? 'structured' : 'page');
  // 3. A posting read recently on the same site: the one sharing an id with this
  //    address if any, otherwise the most recent within the last hour.
  const here = new URL(tab.url).hostname.split('.').slice(-2).join('.');
  const recent = ((await read(session, 'recentJobs')) || []).filter((r) => Date.now() - r.at < 3600000 && new URL(r.url).hostname.endsWith(here));
  const mine = idsIn(tab.url);
  const match = recent.find((r) => [...idsIn(r.url)].some((id) => mine.has(id))) || recent[0];
  if (match) {
    job = { ...match, url: match.url };
    await session.set({ [`job:${tab.id}`]: job });
    return job;
  }
  return null;
}

// The person points to the posting themselves: by its link, or by pasting its text.
async function useJob(tabId, job) {
  await session.set({ [`job:${tabId}`]: job });
  await remember(job);
  // Anything tailored against an earlier, wrong description is no longer wanted.
  const all = await session.get(null);
  await session.remove(Object.keys(all).filter((k) => k.startsWith('tailored:') && !k.endsWith(job.url)));
  toTab(tabId, { type: 'job-info', ok: true, title: job.title, company: job.company, source: job.source }, 0);
  toTab(tabId, { type: 'retailor' });
  return { ok: true, title: job.title, company: job.company };
}

async function setJobFromLink(tabId, url) {
  if (!/^https?:\/\//i.test(url || '')) throw new Error('That is not a link. Paste the full address of the job posting.');
  const listed = await lookupJob(url).catch(() => null);
  const found = listed || (await fetchPostingPage(url).catch(() => null));
  const source = listed ? 'listing' : found?.structured ? 'structured' : 'page';
  if (!found || (source === 'page' && !looksLikePosting(found.jd))) throw new Error("Couldn't read a job description at that link. Paste the description text instead.");
  return useJob(tabId, { url, title: found.title, company: found.company, location: found.location, jd: found.jd, source });
}

async function setJobFromText(tabId, text) {
  const jd = String(text || '').replace(/\s+/g, ' ').trim();
  if (jd.length < 300) throw new Error('That is too short to be a job description.');
  const tab = await chrome.tabs.get(tabId);
  return useJob(tabId, { url: `${tab.url.split('#')[0]}#pasted-description`, title: tab.title || '', company: '', location: '', jd: jd.slice(0, 6000), source: 'pasted' });
}
globalThis.__amSetJobLink = setJobFromLink;

const jobBlock = (job, page) =>
  job?.jd
    ? `<job url="${job.url}" title="${job.title || ''}" company="${job.company || ''}">\n${job.jd}\n</job>`
    : `<job url="${page.url}" title="${page.title}">\n${page.text}\n</job>`;

const stats = (globalThis.__amStats = { calls: 0 });


// One request per form page: everything the rules could not answer goes out together,
// and answers are remembered per job so a refill costs nothing.
// ---- Candidate brief ---------------------------------------------------------
// Instead of the whole profile and every answer the person ever typed, form questions
// get a short fact sheet written once from both, and rewritten only when they change.
const BRIEF_SYSTEM = `Write a compact fact sheet about one job applicant that an assistant will use to answer application form questions for them. Draw only on the profile and the answers they typed on earlier applications; never add anything.

Cover, where known: work authorization and sponsorship; where they live and willingness to relocate, commute or travel; work mode preference; current title, company and total years of experience; roles held (title, company, years); highest education; strongest skills and domains; expected salary, notice period and earliest start; how they usually say they heard about a job; their usual answers to screening questions (former employee, relatives, non-compete, background check, clearance); and the gist of their typed answers to recurring questions (for example why they are looking, what they want next, a proudest project), each in a few words.

Format: terse "topic: answer" lines, no prose, no headings, at most 250 words. Leave out contact details, links and demographic information.`;

const hash = (x) => {
  let h = 0;
  for (const c of JSON.stringify(x)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return String(h);
};

function briefInputs(profile, answers = {}) {
  const { eeo, base_resume, confirmed_experience, locations, links, email, phone, phone_country, phone_type, date_of_birth, resume_text, ...rest } = profile;
  const typed = Object.values(answers).filter((e) => e?.q && !e.private).map((e) => ({ q: e.q, a: [].concat(e.a).join('; ').slice(0, 300) }));
  return { profile: prune(rest), typed };
}

let briefing = null;
async function candidateBrief() {
  const { profile = {}, answers, brief } = await chrome.storage.local.get(['profile', 'answers', 'brief']);
  const inputs = briefInputs(profile, answers);
  const key = hash(inputs);
  if (brief?.key === key) return brief.text;
  if (briefing) return briefing;
  briefing = (async () => {
    const res = await ask({ system: BRIEF_SYSTEM, content: `<profile_and_answers>${JSON.stringify(inputs)}</profile_and_answers>`, schema: obj2({ brief: { type: 'string' } }), use: 'answers', about: 'Candidate brief' });
    await chrome.storage.local.set({ brief: { key, text: res.brief, at: Date.now() } });
    return res.brief;
  })().finally(() => (briefing = null));
  return briefing;
}
const obj2 = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

// Form questions are frequent and mostly short, so their request carries only what the
// questions on this page need: no job description or work history unless one of them
// is an essay, only the earlier answers that resemble these questions, and a profile
// with the empty and rule-handled parts removed.
const isEssay = (f) => f.kind === 'textarea' || (f.max_length || 0) > 200 || f.label.split(/\s+/).length > 14;
const words = (s) => new Set(String(s).toLowerCase().match(/[a-z]{4,}/g) || []);
const prune = (v) => {
  if (Array.isArray(v)) return v.map(prune).filter((x) => x !== undefined);
  if (v && typeof v === 'object') {
    const out = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, prune(x)]).filter(([, x]) => x !== undefined && !(Array.isArray(x) && !x.length) && !(typeof x === 'object' && x && !Array.isArray(x) && !Object.keys(x).length)));
    return Object.keys(out).length ? out : undefined;
  }
  return v === '' || v === null || v === undefined ? undefined : v;
};

function relevantEarlier(answers = {}, fields) {
  const want = fields.map((f) => words(f.label));
  return Object.values(answers)
    .filter((e) => e?.q && !e.private)
    .map((e) => {
      const w = words(e.q);
      return { e, score: Math.max(0, ...want.map((x) => [...x].filter((t) => w.has(t)).length / Math.max(1, Math.min(x.size, w.size)))) };
    })
    .filter((x) => x.score >= 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ e }) => `- ${e.q} => ${[].concat(e.a).join('; ').slice(0, 200)}`);
}

async function mapFields({ fields, page }, tabId) {
  const { profile = {}, answers } = await chrome.storage.local.get(['profile', 'answers']);
  const job = await getJob(tabId, 2000);
  const cacheKey = `ans:${job?.url || page.url}`;
  const cache = (await read(session, cacheKey)) || {};
  const keyOf = (f) => `${f.section || ''}|${f.label}|${f.kind}`;
  const need = fields.filter((f) => !(keyOf(f) in cache));

  if (need.length) {
    const essays = need.some(isEssay);
    // The brief replaces the profile and the earlier answers when it can be had.
    const brief = await candidateBrief().catch(() => null);
    // Never sent: demographic answers, the resume layout, links and contact details the
    // rules fill on their own. Work history and the summary only travel for essays.
    const { eeo, base_resume, confirmed_experience, locations, links, email, phone, phone_country, phone_type, date_of_birth, ...rest } = profile;
    const shared = essays ? rest : (({ experience, summary, notes, resume_text, skills, certifications, ...facts }) => ({ ...facts, roles: (experience || []).map((e) => `${e.title}, ${e.company} (${e.start || ''}-${e.current ? 'present' : e.end || ''})`) }))(rest);
    const where = await applicationLocation(job, profile);
    if (where) {
      shared.home_address = profile.address;
      shared.address = { city: where.city, state: where.state, postal_code: where.postal_code, country: where.country };
    }
    const earlier = brief ? [] : relevantEarlier(answers, need);
    const location = shared.home_address ? `<application_location>${JSON.stringify(shared.address)}</application_location>` : '';
    const facts = brief
      ? `<facts>\n${brief}\n</facts>${location}${essays ? `\n<work_history>${JSON.stringify(prune((profile.experience || []).map(({ company, title, start, end, current, description }) => ({ company, title, start, end, current, description }))))}</work_history>` : ''}`
      : `<profile>${JSON.stringify(prune(shared))}</profile>`;
    const context = [
      facts,
      earlier.length ? `<earlier>\n${earlier.join('\n')}\n</earlier>` : '',
      `<job title="${job?.title || page.title || ''}" company="${job?.company || ''}">${essays ? `\n${(job?.jd || page.text || '').slice(0, 3000)}\n` : ''}</job>`,
    ].filter(Boolean).join('\n');
    const res = await ask({
      system: MAP_SYSTEM,
      content: `${context}\n<fields>${JSON.stringify(need.map((f) => prune(f)))}</fields>`,
      schema: MAP_SCHEMA,
      use: 'answers',
      tabId,
      about: [job?.company, job?.title].filter(Boolean).join(': ') || page.title,
    });
    stats.calls++;
    const byId = new Map(res.answers.map((a) => [a.id, a]));
    for (const f of need) cache[keyOf(f)] = { values: byId.get(f.id)?.values || [], confident: !!byId.get(f.id)?.confident };
    await session.set({ [cacheKey]: cache });
  }
  return { answers: fields.map((f) => ({ id: f.id, ...cache[keyOf(f)] })) };
}

// ---- Application tracker ----------------------------------------------------

// The same posting is reached through several URLs (description page, /apply page,
// tracking parameters), so jobs are matched on a normalized form.
function jobKey(url) {
  try {
    const u = new URL(url);
    const ids = ['gh_jid', 'jid', 'jobId', 'job_id', 'id'].filter((k) => u.searchParams.has(k)).map((k) => `${k}=${u.searchParams.get(k)}`);
    const path = u.pathname.replace(/\/(apply|application)(\/.*)?$/i, '').replace(/\/+$/, '');
    return `${u.host.replace(/^www\./, '')}${path}${ids.length ? `?${ids.join('&')}` : ''}`.toLowerCase();
  } catch {
    return '';
  }
}

async function tabKeys(tab) {
  const job = await getJob(tab.id);
  return [...new Set([jobKey(tab.url), job && jobKey(job.url)].filter(Boolean))];
}

async function findApplication(tab) {
  const keys = await tabKeys(tab);
  const apps = (await read(chrome.storage.local, 'applications')) || {};
  return Object.values(apps).find((a) => a.keys.some((k) => keys.includes(k)));
}

// Tracker updates are applied one at a time so two arriving together cannot overwrite each other.
let tracking = Promise.resolve();
const track = (tab, status, patch) => (tracking = tracking.then(() => trackNow(tab, status, patch), () => trackNow(tab, status, patch)));

async function trackNow(tab, status, patch) {
  const keys = await tabKeys(tab);
  if (!keys.length) return null;
  const apps = (await read(chrome.storage.local, 'applications')) || {};
  const job = await getJob(tab.id);
  const now = new Date().toISOString();
  let app = Object.values(apps).find((a) => a.keys.some((k) => keys.includes(k)));
  if (!app) {
    app = { id: keys[0], keys: [], url: job?.url || tab.url, title: job?.title || tab.title || '', company: job?.company || '', site: new URL(tab.url).host, status: 'started', startedAt: now, times: 0 };
    apps[app.id] = app;
  }
  app.keys = [...new Set([...app.keys, ...keys])];
  // One submission can be noticed more than once (by several frames, or by both the
  // confirmation text and the form disappearing); count it once.
  // `patch.submit` identifies the submit click, so the same click is never counted twice.
  const counted = status === 'applied' && patch?.submit && app.submit === patch.submit;
  if (status === 'applied' && !counted) Object.assign(app, { status: 'applied', appliedAt: now, times: app.times + 1 });
  if (typeof patch === 'function') patch(app);
  else if (patch) Object.assign(app, patch);
  await chrome.storage.local.set({ applications: apps });
  return app;
}

// The location an application uses, with a ZIP. A ZIP the person saved for that city
// wins; otherwise one of the city's real ZIP codes is picked at random the first time
// and then reused, so every application to that city carries the same one. Only the
// city and state are sent to the lookup service. No street address is ever made up.
async function applicationLocation(job, profile) {
  const where = await locateApplication(job?.location, profile, job?.jd);
  if (!where || where.postal_code || where.country !== 'United States' || !where.state) return where;
  const key = `zip:${where.city.toLowerCase()},${where.state}`;
  let zip = await read(chrome.storage.local, key);
  if (!zip) {
    const res = await fetch(`https://api.zippopotam.us/us/${where.state.toLowerCase()}/${encodeURIComponent(where.city.toLowerCase())}`).catch(() => null);
    const places = res?.ok ? (await res.json()).places || [] : [];
    // Codes ending in 00 or 01 are often post-office-only; prefer ordinary ones.
    const codes = places.map((p) => p['post code']).filter((c) => /^\d{5}$/.test(c));
    const usual = codes.filter((c) => !/0[01]$/.test(c));
    const pool = usual.length ? usual : codes;
    zip = pool.length ? pool[Math.floor(Math.random() * pool.length)] : '';
    if (zip) await chrome.storage.local.set({ [key]: zip });
  }
  return { ...where, postal_code: zip };
}

// Adds what a request cost to the application it was made for.
async function addCost(tabId, cost) {
  const tab = cost && Number.isInteger(tabId) && (await chrome.tabs.get(tabId).catch(() => null));
  if (tab?.url) track(tab, 'started', (app) => Object.assign(app, { cost: (app.cost || 0) + cost, requests: (app.requests || 0) + 1 }));
}

// Keeps the exact resume that went to a job with that job's tracker entry, and (unless
// switched off) also saves it as a file in Downloads/ApplyMate named after the job.
async function keepResumeCopy(tabId, file, tailored) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.url) return;
  const at = new Date().toISOString();
  const app = await track(tab, 'started', { resume: { name: file.name, at, tailored: true, location: tailored.location || '' } });
  if (!app) return;
  await chrome.storage.local.set({ [`resumefile:${app.id}`]: { ...file, at, text: tailored } });
  const { settings = {} } = await chrome.storage.local.get('settings');
  if (settings.saveFiles === false) return;
  const safe = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  const filename = `ApplyMate/${[safe(app.company || app.site), safe(app.title), at.slice(0, 10)].filter(Boolean).join(' - ')}.pdf`;
  const id = await chrome.downloads.download({ url: `data:application/pdf;base64,${file.base64}`, filename, saveAs: false, conflictAction: 'uniquify' }).catch(() => null);
  if (id != null) track(tab, 'started', { resume: { name: file.name, at, tailored: true, location: tailored.location || '', savedAs: filename } });
}

async function markApplied(tab, submit = Date.now()) {
  const app = await track(tab, 'applied', { submit });
  await session.remove([`pending:${tab.id}`, `again:${tab.id}`]);
  if (app) toTab(tab.id, { type: 'applied-now', entry: app }, 0);
}

// A submit click only counts once the page confirms it or the form goes away.
async function maybeApplied(tab, msg) {
  const pending = await read(session, `pending:${tab.id}`);
  if (pending && Date.now() - pending < 120000 && (msg.confirmed || (msg.submitter && msg.count === 0))) await markApplied(tab, pending);
}

async function alreadyApplied(tab) {
  // "Apply again" lifts the warning for that tab for half an hour, long enough to get
  // through the application, and then it returns.
  const again = await read(session, `again:${tab.id}`);
  if (again && Date.now() - again < 30 * 60000) return null;
  const app = await findApplication(tab);
  if (app?.status !== 'applied') return null;
  toTab(tab.id, { type: 'already', entry: app }, 0);
  return app;
}

async function applyAgain(tabId) {
  await session.set({ [`again:${tabId}`]: Date.now() });
  reports[tabId] = [];
  toTab(tabId, { type: 'run' });
}
globalThis.__amApplyAgain = applyAgain;

// ---- Auto-fill memory across page reloads ------------------------------------
// Some portals (iCIMS) reload the whole page when a resume is uploaded or a dropdown
// changes. Without a memory that outlives the page, each reload would look like a new
// form and be filled again, forever. This remembers, per tab and page, which questions
// already had their one automatic pass and which field caused a reload.
const autoMem = new Map();
async function autoState(tabId, key) {
  const id = `auto:${tabId}:${key}`;
  if (!autoMem.has(id)) autoMem.set(id, (await read(session, id)) || { labels: [], skip: [], last: null, busy: false, interrupted: false, passes: 0 });
  const st = autoMem.get(id);
  return { st, save: () => session.set({ [id]: st }) };
}

const CHOOSE_SCHEMA = obj({ choice: str });

// A dropdown's visible options did not clearly match the intended value; ask which one fits.
async function chooseOption({ label, section, want, options }, tabId) {
  const job = await getJob(tabId);
  const cacheKey = `pick:${job?.url || tabId}`;
  const cache = (await read(session, cacheKey)) || {};
  const key = `${section || ''}|${label}|${want}|${options.join('|').slice(0, 300)}`;
  if (!(key in cache)) {
    const res = await ask({
      system: 'A job application dropdown is showing a list of options, and none is an exact match for what the applicant means. Choose the option that means the same thing or is the closest correct fit (for example the right school, degree level or field of study). Return it exactly as written in the list. If no option is a reasonable fit, return an empty string.',
      content: `<question>${section ? `${section}: ` : ''}${label}</question>\n<applicant_value>${want}</applicant_value>\n<options>\n${JSON.stringify(options)}\n</options>`,
      schema: CHOOSE_SCHEMA,
      use: 'answers',
      tabId,
      about: label,
    });
    stats.calls++;
    cache[key] = options.includes(res.choice) ? res.choice : '';
    await session.set({ [cacheKey]: cache });
  }
  return { choice: cache[key] };
}

const extensionFile = async (path) => new Uint8Array(await (await fetch(chrome.runtime.getURL(path))).arrayBuffer());

function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const tailoring = new Map();

// One request per job: a resume rewritten for this description, rendered to PDF.
function tailorResume(tabId) {
  const work = (async () => {
    // A careers landing page or a bare form is not a job description; tailoring against
    // it would produce a generic rewrite, so without a real posting nothing is tailored.
    const tab = await chrome.tabs.get(tabId);
    const job = await ensureJob(tab);
    if (!job) throw new Error('could not find this job\'s description');
    const key = `tailored:${job.url}`;
    const done = await read(session, key);
    if (done) return { ...done, key };
    if (tailoring.has(key)) return tailoring.get(key);

    const run = (async () => {
      const profile = (await read(chrome.storage.local, 'profile')) || {};
      if (!profile.base_resume && !profile.experience?.length) throw new Error('Your profile has no work history to tailor.');
      // With a base resume in the profile, the original layout is kept and only the
      // summary, bullets and location change; otherwise the built-in layout is used.
      const fonts = profile.base_resume ? { regular: await extensionFile('fonts/Carlito-Regular.woff'), bold: await extensionFile('fonts/Carlito-Bold.woff') } : null;
      const about = [job.company, job.title].filter(Boolean).join(': ');
      // Pages after the first in the uploaded resume are carried over as they are.
      const stored = profile.base_resume && (await read(chrome.storage.local, 'resume'));
      const original = stored?.base64 ? Uint8Array.from(atob(stored.base64), (c) => c.charCodeAt(0)) : null;
      const made = await tailorPdf({
        profile,
        job,
        fonts,
        original,
        location: (await applicationLocation(job, profile))?.label || '',
        ask: (request) => {
          stats.calls++;
          return ask({ ...request, use: 'resume', about, tabId });
        },
      });
      // Text that will not fit the fixed page is not sent out; the original is attached instead.
      if (!made.fits) throw new Error('the tailored text did not fit your one-page layout');
      const file = {
        name: `${[profile.first_name, profile.last_name].filter(Boolean).join('_') || 'Resume'}_Resume.pdf`,
        type: 'application/pdf',
        base64: toBase64(made.bytes),
        // The tailored wording itself, so matching boxes on the form can carry the same text.
        text: made.tailored,
      };
      await session.set({ [key]: file });
      keepResumeCopy(tabId, file, made.tailored).catch(() => {});
      return { ...file, key };
    })();
    tailoring.set(key, run);
    try {
      return await run;
    } finally {
      tailoring.delete(key);
    }
  })();
  return work;
}

async function importResume({ base64 }) {
  return ask({
    system: RESUME_SYSTEM,
    content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
      { type: 'text', text: 'Extract this resume.' },
    ],
    schema: RESUME_SCHEMA,
    use: 'resume',
  });
}

const reports = (globalThis.__amReports = {});
// Pages Chrome loads outside a normal tab (prerendered pages, side panels, popups in
// apps) report a tab id of -1 and cannot be messaged.
const isTab = (tabId) => Number.isInteger(tabId) && tabId >= 0;
const toTab = (tabId, msg, frameId) =>
  isTab(tabId) ? chrome.tabs.sendMessage(tabId, msg, frameId === undefined ? {} : { frameId }).catch(() => {}) : Promise.resolve();

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  const tabId = sender.tab?.id;
  // Everything except resume import and the timer helper is about a real tab.
  if (!isTab(tabId) && msg.type !== 'import-resume' && msg.type !== 'sleep') return respond({ error: 'not in a tab' }), false;
  switch (msg.type) {
    case 'sleep':
      setTimeout(() => respond(true), Math.min(msg.ms, 20000));
      return true;
    case 'map':
      mapFields(msg, tabId).then(respond, (e) => respond({ error: e.message }));
      return true;
    case 'auto-state':
      autoState(tabId, msg.key).then(({ st, save }) => {
        // This memory exists to stop a page that reloads itself from being refilled in a
        // loop. A page opened again well after the last fill finished (a refresh by the
        // person, or coming back to the job later) starts clean and is filled as new.
        if (!st.busy && st.touched && Date.now() - st.touched > 20000) {
          Object.assign(st, { labels: [], skip: [], last: null, interrupted: false, passes: 0 });
          save();
        }
        // The page loaded again while a fill was under way: the last field touched caused it.
        if (st.busy && st.last) {
          if (!st.skip.includes(st.last)) st.skip.push(st.last);
          Object.assign(st, { busy: false, interrupted: true });
          save();
        }
        respond(st);
      }, () => respond(null));
      return true;
    case 'filling':
      autoState(tabId, msg.key).then(({ st, save }) => {
        if (!st.labels.includes(msg.label)) st.labels.push(msg.label);
        Object.assign(st, { last: msg.label, busy: true, touched: Date.now() });
        save();
      });
      break;
    case 'run-done':
      autoState(tabId, msg.key).then(({ st, save }) => {
        st.labels = [...new Set([...st.labels, ...msg.labels])];
        Object.assign(st, { busy: false, touched: Date.now(), passes: st.passes + (msg.auto ? 1 : 0) });
        save();
      });
      break;
    case 'apply-location':
      (async () => {
        const profile = (await read(chrome.storage.local, 'profile')) || {};
        respond({ where: await applicationLocation(await getJob(tabId, 1500), profile) });
      })().catch(() => respond({ where: null }));
      return true;
    case 'choose':
      chooseOption(msg, tabId).then(respond, () => respond({ choice: '' }));
      return true;
    case 'tailor':
      tailorResume(tabId).then(respond, (e) => respond({ error: e.message }));
      return true;
    case 'import-resume':
      importResume(msg).then((profile) => respond({ profile }), (e) => respond({ error: e.message }));
      return true;
    case 'job':
      noteJob(tabId, msg);
      break;
    case 'job-status':
      ensureJob(sender.tab).then((job) => {
        const info = { ok: !!job, title: job?.title || '', company: job?.company || '', source: job?.source || '' };
        toTab(tabId, { type: 'job-info', ...info }, 0);
        respond(info);
      }, () => respond({ ok: false }));
      return true;
    case 'set-job-link':
      setJobFromLink(tabId, msg.url).then(respond, (e) => respond({ ok: false, reason: e.message }));
      return true;
    case 'set-job-text':
      setJobFromText(tabId, msg.text).then(respond, (e) => respond({ ok: false, reason: e.message }));
      return true;
    case 'job-hint':
      // An embedded job-board frame pointing at the actual posting.
      (async () => {
        const job = await getJob(tabId, 1500);
        if (!job || job.source === 'listing') return;
        const found = await lookupJob(msg.url);
        if (!found) return;
        Object.assign(job, { title: found.title, company: found.company || job.company, location: found.location || job.location, jd: found.jd, source: 'listing' });
        await session.set({ [`job:${tabId}`]: job });
        remember(job);
      })().catch(() => {});
      break;
    case 'applied?':
      alreadyApplied(sender.tab).then((entry) => respond({ entry }), () => respond({}));
      return true;
    case 'submitting':
      session.set({ [`pending:${tabId}`]: Date.now() });
      break;
    case 'mark-applied':
      markApplied(sender.tab);
      break;
    case 'apply-again':
      applyAgain(tabId);
      break;
    case 'report':
      (reports[tabId] ||= []).push(msg);
      if (msg.rows?.length) track(sender.tab, 'started');
      toTab(tabId, msg, 0);
      break;
    case 'need-job':
      toTab(tabId, msg, 0);
      break;
    case 'detected':
      if (msg.confirmed || msg.submitter) maybeApplied(sender.tab, msg);
    // falls through
    case 'progress':
    case 'learned':
      toTab(tabId, msg, 0);
      break;
    case 'focus':
      toTab(tabId, msg);
      break;
    case 'run-tab':
      reports[tabId] = [];
      toTab(tabId, { type: 'run' });
      break;
    case 'learn-tab':
      toTab(tabId, { type: 'learn' });
      break;
    case 'preview':
      chrome.tabs.create({ url: `${chrome.runtime.getURL('options/preview.html')}?k=${encodeURIComponent(msg.key)}` });
      break;
    case 'open-options':
      chrome.runtime.openOptionsPage();
      break;
  }
});

const runOn = (tab) => tab?.id && ((reports[tab.id] = []), toTab(tab.id, { type: 'run' }));
chrome.action.onClicked.addListener(runOn);
chrome.commands.onCommand.addListener((command, tab) => command === 'fill' && runOn(tab));
chrome.runtime.onInstalled.addListener(({ reason }) => reason === 'install' && chrome.runtime.openOptionsPage());

// Apply links often open the form in a new tab; carry the job description over.
chrome.tabs.onCreated.addListener(async (tab) => {
  const job = tab.openerTabId && (await getJob(tab.openerTabId));
  if (job) session.set({ [`job:${tab.id}`]: job });
});
chrome.tabs.onRemoved.addListener((tabId) => session.remove([`job:${tabId}`, `pending:${tabId}`, `again:${tabId}`]));
