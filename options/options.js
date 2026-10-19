const $ = (id) => document.getElementById(id);
const status = (text) => ($('status').textContent = text);
const h = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};

const YES_NO = 'bool';
const DECLINE = 'Decline to self-identify';

// Everything the extension can answer from. `path` is where the value lives in the
// stored profile; rules read it directly and the whole profile (except "Demographic
// questions") is given to the AI as background for custom questions.
const SECTIONS = [
  { title: 'About you', fields: [
    ['first_name', 'First name'], ['middle_name', 'Middle name'], ['last_name', 'Last name'], ['preferred_name', 'Preferred name'],
    ['email', 'Email'], ['phone', 'Phone', { hint: 'with country code' }], ['phone_country', 'Phone country'], ['phone_type', 'Phone type', { options: ['Mobile', 'Home', 'Work'] }],
    ['date_of_birth', 'Date of birth', { type: 'date', hint: 'only filled when a form asks' }],
  ] },
  { title: 'Address', fields: [
    ['address.line1', 'Street address', { wide: true }], ['address.line2', 'Apartment, suite'], ['address.city', 'City'],
    ['address.state', 'State / province'], ['address.postal_code', 'ZIP / postal code'], ['address.country', 'Country'],
  ] },
  { title: 'Locations you apply from', path: 'locations', add: 'Add a location',
    hint: 'When a job is in one of these cities, the resume and the form use that city, with the ZIP and street you give here. List them in order of preference: if a posting names several cities, the first one on your list wins. A job in a US city not listed here still uses that city and state, with a ZIP code from that city picked at random the first time and reused afterwards; the street is left empty.', fields: [
    ['city', 'City'], ['state', 'State', { hint: 'two letters, e.g. NY' }], ['postal_code', 'ZIP / postal code'], ['country', 'Country'], ['line1', 'Street address', { hint: 'optional' }],
  ] },
  { title: 'Links', fields: [
    ['links.linkedin', 'LinkedIn'], ['links.github', 'GitHub'], ['links.portfolio', 'Portfolio / website'], ['links.twitter', 'X / Twitter'], ['links.other', 'Other link'],
  ] },
  { title: 'Work authorization', hint: 'Visa and sponsorship questions are answered from these facts and always flagged for you to review.', fields: [
    ['work_authorization.citizenship', 'Citizenship', { hint: 'country or countries' }],
    ['work_authorization.visa_status', 'Current status', { hint: 'e.g. US citizen, Green card, H-1B, F-1 OPT' }],
    ['work_authorization.visa_expiry', 'Status expires', { type: 'date' }],
    ['work_authorization.authorized_countries', 'Countries you can work in today', { type: 'list' }],
    ['work_authorization.authorized_us', 'Authorized to work in the US?', { type: YES_NO }],
    ['work_authorization.needs_sponsorship', 'Need sponsorship now?', { type: YES_NO }],
    ['work_authorization.needs_sponsorship_in_future', 'Need sponsorship in the future?', { type: YES_NO }],
    ['work_authorization.eligible_where_job_is', 'Eligible to work wherever the job is located?', { type: YES_NO, hint: 'Yes answers every "are you authorized / eligible to work in this location" question with Yes, however it is worded' }],
  ] },
  { title: 'Current role', fields: [
    ['current_title', 'Current title'], ['current_company', 'Current company'], ['years_experience', 'Total years of experience'],
    ['summary', 'One-paragraph summary', { type: 'textarea', wide: true }],
    ['skills', 'Skills', { type: 'list', wide: true }], ['certifications', 'Certifications', { type: 'list', wide: true }],
  ] },
  { title: 'Work history', path: 'experience', add: 'Add a job', fields: [
    ['title', 'Title'], ['company', 'Company'], ['location', 'Location'], ['start', 'Start', { type: 'month' }], ['end', 'End', { type: 'month' }],
    ['current', 'I work here now', { type: YES_NO }], ['description', 'What you did', { type: 'textarea', wide: true, hint: 'the tailored resume is written from this' }],
  ] },
  { title: 'Education', path: 'education', add: 'Add a school', fields: [
    ['school', 'School'], ['degree', 'Degree'], ['field', 'Field of study'], ['start', 'Start', { type: 'month' }], ['end', 'End', { type: 'month' }], ['gpa', 'GPA'],
  ] },
  { title: 'Education summary', fields: [
    ['highest_degree', 'Highest degree', { options: ['High School', "Associate's Degree", "Bachelor's Degree", "Master's Degree", 'MBA', 'Doctorate (PhD)', 'Other'] }],
    ['graduation_year', 'Graduation year'],
  ] },
  { title: 'Languages', path: 'languages', add: 'Add a language', fields: [
    ['language', 'Language'], ['proficiency', 'Proficiency', { options: ['Native', 'Fluent', 'Professional', 'Conversational', 'Basic'] }],
  ] },
  { title: 'Job preferences', fields: [
    ['preferences.salary_expectation', 'Expected salary'], ['preferences.salary_currency', 'Currency'], ['preferences.current_salary', 'Current salary', { hint: 'leave empty to skip' }],
    ['preferences.notice_period', 'Notice period'], ['preferences.earliest_start_date', 'Earliest start date', { type: 'date' }],
    ['preferences.work_mode', 'Preferred work mode', { options: ['Remote', 'Hybrid', 'On-site', 'Any'] }],
    ['preferences.employment_type', 'Employment type', { options: ['Full-time', 'Part-time', 'Contract', 'Internship'] }],
    ['preferences.preferred_locations', 'Preferred locations', { type: 'list' }],
    ['preferences.willing_to_relocate', 'Willing to relocate?', { type: YES_NO }], ['preferences.willing_to_travel', 'Willing to travel?', { type: YES_NO }],
    ['preferences.travel_percent', 'Travel you would accept (%)'],
  ] },
  { title: 'Common screening questions', hint: 'Leave any of these on “Ask me” and the question is left for you.', fields: [
    ['screening.over_18', 'Are you 18 or older?', { type: YES_NO }], ['screening.drivers_license', "Valid driver's license?", { type: YES_NO }],
    ['screening.background_check_ok', 'OK with a background check?', { type: YES_NO }], ['screening.drug_test_ok', 'OK with a drug test?', { type: YES_NO }],
    ['screening.non_compete', 'Bound by a non-compete?', { type: YES_NO }], ['screening.worked_here_before', 'Worked for this employer before?', { type: YES_NO, hint: 'your usual answer' }],
    ['screening.relatives_at_company', 'Relatives at this employer?', { type: YES_NO, hint: 'your usual answer' }],
    ['screening.no_employer_ties', 'Answer "No" to ties with the employer?', { type: YES_NO, hint: 'former employee, alum, parent of a student, family or close relationship, conflict of interest' }], ['screening.security_clearance', 'Security clearance', { hint: 'e.g. None, Secret' }],
  ] },
  { title: 'Other', fields: [
    ['how_did_you_hear', 'How did you hear about us?', { hint: 'your usual answer' }], ['referral_name', 'Referred by'],
    ['notes', 'Anything else the AI should know', { type: 'textarea', wide: true, hint: 'what you are looking for, proudest work, strengths. Used for “why do you want to work here” style questions.' }],
    ['resume_text', 'Master resume text', { type: 'textarea', wide: true, hint: 'filled by resume import; the source for tailored resumes and written answers' }],
  ] },
  { title: 'Demographic questions', hint: 'Optional. Filled only from what you choose here, and never sent to the AI. Leave on “Ask me” to answer these yourself each time.', fields: [
    ['eeo.gender', 'Gender', { options: ['Male', 'Female', 'Non-binary', DECLINE] }],
    ['eeo.hispanic', 'Hispanic or Latino?', { options: ['Yes', 'No', DECLINE] }],
    ['eeo.race', 'Race / ethnicity', { options: ['American Indian or Alaska Native', 'Asian', 'Black or African American', 'Hispanic or Latino', 'Native Hawaiian or Other Pacific Islander', 'White', 'Two or More Races', DECLINE] }],
    ['eeo.veteran', 'Veteran status', { options: ['I am not a protected veteran', 'I identify as one or more of the classifications of a protected veteran', DECLINE] }],
    ['eeo.disability', 'Disability', { options: ['No, I do not have a disability', 'Yes, I have a disability', DECLINE] }],
    ['eeo.sexual_orientation', 'Sexual orientation', { hint: 'your wording' }], ['eeo.transgender', 'Transgender?', { options: ['Yes', 'No', DECLINE] }],
    ['eeo.pronouns', 'Pronouns'],
  ] },
];

const get = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
function set(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => (o[k] ??= {}), obj)[last] = value;
}

let profile = {};

function control([path, label, opt = {}], value, scope) {
  let input;
  if (opt.type === YES_NO || opt.options) {
    input = h('select');
    const choices = opt.type === YES_NO ? [['', 'Ask me'], ['true', 'Yes'], ['false', 'No']] : [['', path.startsWith('eeo.') ? 'Ask me' : '—'], ...opt.options.map((o) => [o, o])];
    for (const [v, t] of choices) input.append(h('option', { value: v, textContent: t }));
    input.value = opt.type === YES_NO ? (value === true ? 'true' : value === false ? 'false' : '') : value || '';
    // A saved value that is not one of the presets stays selectable.
    if (value && typeof value === 'string' && input.value !== value) {
      input.append(h('option', { value, textContent: value }));
      input.value = value;
    }
  } else if (opt.type === 'textarea') {
    input = h('textarea', { value: value || '' });
  } else {
    input = h('input', { type: opt.type === 'date' || opt.type === 'month' ? opt.type : 'text' });
    input.value = opt.type === 'list' ? [].concat(value || []).join(', ') : opt.type === 'month' ? String(value || '').slice(0, 7) : value ?? '';
    if (opt.type === 'list') input.placeholder = 'separate with commas';
  }
  input.dataset.path = path;
  input.dataset.kind = opt.type || (opt.options ? 'choice' : 'text');
  input.id = `${scope}${path}`;
  const lab = h('label', { htmlFor: input.id }, label, ...(opt.hint ? [' ', h('span', { className: 'hint', textContent: opt.hint })] : []));
  return h('div', { className: opt.wide ? 'wide' : '' }, lab, input);
}

function readControl(input) {
  const v = input.value.trim();
  if (input.dataset.kind === YES_NO) return v === '' ? null : v === 'true';
  if (input.dataset.kind === 'list') return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];
  return v;
}

function entry(section, item, n) {
  const grid = h('div', { className: 'grid' }, ...section.fields.map((f) => control(f, item[f[0]], `${section.path}.${n}.`)));
  const remove = h('button', { textContent: 'Remove', type: 'button' });
  const box = h('div', { className: 'entry' }, grid, h('div', { className: 'row' }, remove));
  box.dataset.list = section.path;
  remove.addEventListener('click', () => box.remove());
  return box;
}

function render() {
  const form = $('form');
  form.replaceChildren();
  for (const section of SECTIONS) {
    form.append(h('h2', { textContent: section.title }));
    if (section.hint) form.append(h('p', { textContent: section.hint }));
    if (!section.path) {
      form.append(h('div', { className: 'grid' }, ...section.fields.map((f) => control(f, get(profile, f[0]), ''))));
      continue;
    }
    const list = h('div');
    (profile[section.path] || []).forEach((item, n) => list.append(entry(section, item, n)));
    const add = h('button', { textContent: section.add, type: 'button' });
    add.addEventListener('click', () => list.append(entry(section, {}, Date.now())));
    form.append(list, h('div', { className: 'row' }, add));
  }
  $('profile').value = JSON.stringify(profile, null, 2);
}

// Reads the form back into the profile, keeping any keys the form does not show.
function collect() {
  const next = structuredClone(profile);
  for (const input of $('form').querySelectorAll('.grid [data-path]')) {
    if (!input.closest('.entry')) set(next, input.dataset.path, readControl(input));
  }
  for (const section of SECTIONS.filter((s) => s.path)) {
    next[section.path] = [...$('form').querySelectorAll(`.entry[data-list="${section.path}"]`)]
      .map((box) => Object.fromEntries([...box.querySelectorAll('[data-path]')].map((i) => [i.dataset.path, readControl(i)])))
      .filter((item) => Object.values(item).some((v) => v !== '' && v !== null));
  }
  return next;
}

function renderAnswers(answers = {}) {
  const table = $('answers');
  table.replaceChildren();
  for (const [q, a] of Object.entries(answers)) {
    const tr = table.insertRow();
    tr.insertCell().textContent = a?.q || q;
    tr.insertCell().textContent = [].concat(a?.a ?? a).join(', ');
  }
}

const APP_COLUMNS = [['Company', (a) => a.company || a.site], ['Job', (a) => a.title], ['Status', (a) => a.status], ['Applied', (a) => (a.appliedAt || '').slice(0, 10)],
  ['First opened', (a) => (a.startedAt || '').slice(0, 10)], ['Times applied', (a) => a.times], ['Link', (a) => a.url],
  ['AI cost (USD, estimated)', (a) => (a.cost ? a.cost.toFixed(4) : '')], ['AI requests', (a) => a.requests || ''],
  ['Resume used', (a) => (a.resume ? (a.resume.tailored ? 'Tailored' : 'Original') : '')], ['Resume location line', (a) => a.resume?.location || ''], ['Resume file', (a) => a.resume?.savedAs || '']];

async function renderApps() {
  const { applications = {} } = await chrome.storage.local.get('applications');
  const apps = Object.values(applications).sort((a, b) => (b.appliedAt || b.startedAt).localeCompare(a.appliedAt || a.startedAt));
  const table = $('apps');
  table.replaceChildren();
  if (!apps.length) return void (table.insertRow().insertCell().textContent = 'Nothing tracked yet.');
  const head = table.insertRow();
  for (const t of ['Company', 'Job', 'Status', 'Applied', 'AI cost', 'Resume sent', '']) head.append(h('th', { textContent: t }));
  for (const a of apps) {
    const tr = table.insertRow();
    tr.insertCell().textContent = a.company || a.site;
    tr.insertCell().append(h('a', { href: a.url, target: '_blank', textContent: a.title || a.url }));
    const status = tr.insertCell();
    status.textContent = a.status === 'applied' ? (a.times > 1 ? `Applied ${a.times} times` : 'Applied') : 'Started';
    if (a.times > 1) status.title = 'You submitted this application more than once (after choosing "Apply again").';
    tr.insertCell().textContent = a.appliedAt ? new Date(a.appliedAt).toLocaleDateString() : '';
    tr.insertCell().textContent = a.cost ? `$${a.cost.toFixed(3)}` : '';
    const resume = tr.insertCell();
    if (a.resume?.tailored) {
      const open = h('button', { textContent: 'Open copy' });
      open.title = a.resume.savedAs ? `Also saved in Downloads as ${a.resume.savedAs}` : '';
      open.addEventListener('click', () => chrome.tabs.create({ url: `${chrome.runtime.getURL('options/preview.html')}?k=${encodeURIComponent(`resumefile:${a.id}`)}` }));
      resume.append(open);
    }
    const remove = h('button', { textContent: 'Remove' });
    remove.addEventListener('click', async () => {
      const { applications: all = {} } = await chrome.storage.local.get('applications');
      delete all[a.id];
      await chrome.storage.local.remove(`resumefile:${a.id}`);
      await chrome.storage.local.set({ applications: all });
      renderApps();
    });
    tr.insertCell().append(remove);
  }
}

async function exportApps() {
  const { applications = {} } = await chrome.storage.local.get('applications');
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [APP_COLUMNS.map(([t]) => cell(t)), ...Object.values(applications).map((a) => APP_COLUMNS.map(([, get]) => cell(get(a))))];
  const link = h('a', { href: URL.createObjectURL(new Blob([lines.map((l) => l.join(',')).join('\r\n')], { type: 'text/csv' })), download: 'applications.csv' });
  link.click();
  URL.revokeObjectURL(link.href);
}

async function renderLog() {
  const { promptLog = [] } = await chrome.storage.local.get('promptLog');
  const box = $('log');
  box.replaceChildren();
  if (!promptLog.length) return void box.append(h('p', { textContent: 'Nothing logged yet.' }));
  const total = promptLog.reduce((n, e) => n + (e.cost || 0), 0);
  box.append(h('p', { textContent: `Estimated cost of the ${promptLog.length} requests shown: $${total.toFixed(4)}, from the token counts the API reported and list prices.` }));
  for (const e of promptLog) {
    const spend = e.cost != null ? ` · $${e.cost.toFixed(4)} (${e.tokens.in.toLocaleString()} tokens in, ${e.tokens.out.toLocaleString()} out)` : '';
    const title = `${new Date(e.at).toLocaleString()} · ${e.use === 'resume' ? 'Resume' : 'Form questions'} · ${e.about || ''} · ${e.model} · ${e.seconds?.toFixed(1)} s${spend}${e.error ? ' · FAILED' : ''}`;
    const body = `===== INSTRUCTIONS =====\n${e.system}\n\n===== SENT =====\n${e.content}\n\n===== ${e.error ? 'ERROR' : 'RESPONSE'} =====\n${e.error || JSON.stringify(e.response, null, 2)}`;
    box.append(h('details', {}, h('summary', { textContent: title }), h('pre', { textContent: body })));
  }
}

async function load() {
  const { profile: saved, settings = {}, resume, answers } = await chrome.storage.local.get(['profile', 'settings', 'resume', 'answers']);
  $('apiKey').value = settings.apiKey || '';
  $('answerModel').value = settings.answerModel || 'claude-haiku-4-5';
  $('resumeModel').value = settings.resumeModel || 'claude-opus-5-5';
  $('autoFill').checked = settings.autoFill !== false;
  $('tailor').checked = settings.tailor !== false;
  $('fast').checked = !!settings.fast;
  $('saveFiles').checked = settings.saveFiles !== false;
  $('replacePrefilled').checked = settings.replacePrefilled !== false;
  $('answerProvider').value = settings.answerProvider || 'claude';
  $('localModel').value = settings.localModel || '';
  $('localUrl').value = settings.localUrl || '';
  showLocal();
  $('resumeName').textContent = resume ? `Saved: ${resume.name}` : '';
  profile = saved || {};
  render();
  renderAnswers(answers);
  renderApps();
  renderLog();
}

async function save() {
  profile = collect();
  const { settings = {} } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({
    profile,
    settings: { ...settings, apiKey: $('apiKey').value.trim(), answerModel: $('answerModel').value, resumeModel: $('resumeModel').value, autoFill: $('autoFill').checked, tailor: $('tailor').checked, fast: $('fast').checked, saveFiles: $('saveFiles').checked, replacePrefilled: $('replacePrefilled').checked, answerProvider: $('answerProvider').value, localModel: $('localModel').value.trim(), localUrl: $('localUrl').value.trim() },
  });
  $('profile').value = JSON.stringify(profile, null, 2);
  status('Saved.');
}

function readBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

$('resumeFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  await chrome.storage.local.set({ resume: { name: file.name, type: file.type, base64: await readBase64(file) } });
  $('resumeName').textContent = `Saved: ${file.name}`;
});

$('import').addEventListener('click', async () => {
  const { resume } = await chrome.storage.local.get('resume');
  if (!resume) return status('Choose a resume PDF first.');
  await save();
  status('Reading your resume…');
  const res = await chrome.runtime.sendMessage({ type: 'import-resume', base64: resume.base64 });
  if (res.error) return status(res.error);
  // The resume fills what it can; everything it cannot know (work authorization,
  // preferences, screening and demographic answers) is kept as you set it.
  profile = { ...profile, ...res.profile };
  render();
  await save();
  status('Imported from your resume. Fill in work authorization and preferences, then save.');
});

const showLocal = () => ($('localBox').hidden = $('answerProvider').value !== 'local');
$('answerProvider').addEventListener('change', showLocal);
$('save').addEventListener('click', save);
$('export').addEventListener('click', exportApps);
$('downloadLog').addEventListener('click', async () => {
  const { promptLog = [] } = await chrome.storage.local.get('promptLog');
  const link = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(promptLog, null, 2)], { type: 'application/json' })), download: 'applymate-prompt-log.json' });
  link.click();
  URL.revokeObjectURL(link.href);
});
$('clearLog').addEventListener('click', async () => {
  await chrome.storage.local.remove('promptLog');
  renderLog();
});
$('sample').addEventListener('click', async () => {
  profile = await (await fetch(chrome.runtime.getURL('profile.sample.json'))).json();
  render();
  status('Sample loaded. Press Save to keep it.');
});
$('download').addEventListener('click', () => {
  const link = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(collect(), null, 2)], { type: 'application/json' })), download: 'my-profile.json' });
  link.click();
  URL.revokeObjectURL(link.href);
});
// Loads a whole profile from a file (for example one prepared outside the extension).
$('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  let loaded;
  try {
    loaded = JSON.parse(await file.text());
  } catch (err) {
    return status(`That file is not valid JSON: ${err.message}`);
  }
  // Merge, do not replace: whatever the file leaves out or leaves empty keeps the value
  // already here (work authorization, preferences, screening answers and so on).
  const empty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);
  const merge = (mine, theirs) => {
    if (theirs && typeof theirs === 'object' && !Array.isArray(theirs) && mine && typeof mine === 'object' && !Array.isArray(mine)) {
      const out = { ...mine };
      for (const k of Object.keys(theirs)) out[k] = merge(mine[k], theirs[k]);
      return out;
    }
    return empty(theirs) ? mine ?? theirs : theirs;
  };
  profile = merge(collect(), loaded);
  render();
  await save();
  status(`Loaded and saved ${file.name}${profile.base_resume ? ', including your resume layout' : ''}.`);
});
$('applyJson').addEventListener('click', () => {
  try {
    profile = JSON.parse($('profile').value || '{}');
  } catch (e) {
    return status(`Not valid JSON: ${e.message}`);
  }
  render();
  status('Applied. Press Save to keep it.');
});
$('clear').addEventListener('click', async () => {
  await chrome.storage.local.remove('answers');
  renderAnswers();
});

$('version').textContent = `version ${chrome.runtime.getManifest().version}`;
load();
