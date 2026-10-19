// Per-frame orchestration: capture the job description, detect a form, answer every
// field (saved answer -> profile rule -> one AI request for the rest), and report
// to the panel. The tailored resume is built in parallel and attached when ready.
(() => {
  const AM = globalThis.__AM;
  if (AM.frame) return;
  AM.frame = Math.random().toString(36).slice(2);

  const isTop = window.top === window;
  const send = (msg) => AM.safe(() => chrome.runtime.sendMessage({ ...msg, frame: AM.frame }));
  // Entry points stop quietly, rather than throwing, once the extension has been reloaded.
  const guarded = (fn) => async (...args) => {
    if (!AM.alive()) return;
    try {
      return await fn(...args);
    } catch (e) {
      if (!/context invalidated/i.test(String(e?.message))) throw e;
      AM.dead = true;
    }
  };
  const HAS_OPTIONS = new Set(['select', 'radio', 'buttons', 'checkboxes']);
  const ATS = /apply|application|career|job|resume|greenhouse|lever\.co|ashby|workday|icims|smartrecruiters|workable|taleo|jobvite|bamboohr/i;
  const JD_CHARS = 6000;
  const MULTI_STEP = /myworkdayjobs|myworkdaysite|icims\.com|taleo\.net|successfactors|oraclecloud/i;

  const serialize = (f) => ({
    id: f.id, label: f.label, kind: f.kind === 'dateparts' ? 'date' : f.kind, required: f.required || undefined,
    section: f.section || undefined, placeholder: f.placeholder || undefined,
    // A long list (countries, universities) is not sent; the answer is searched for in it here.
    options: f.options?.length > 25 ? undefined : f.options, long_list: f.options?.length > 25 || undefined,
    max_length: f.el.maxLength > 0 ? f.el.maxLength : undefined,
    min: (f.kind === 'number' && f.el.min) || undefined, max: (f.kind === 'number' && f.el.max) || undefined,
  });

  // Fallback context when no job description was captured for this tab.
  const pageContext = () => ({ url: location.href, title: document.title, text: AM.norm(document.body?.innerText).slice(0, 1500) });

  // The posting's own structured data when present, else the page's main text.
  function jobInfo() {
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(s.textContent);
        const post = [].concat(data['@graph'] || data).find((x) => x?.['@type'] === 'JobPosting');
        if (!post?.description) continue;
        const jd = AM.norm(new DOMParser().parseFromString(post.description, 'text/html').body.textContent);
        // Every location the posting lists, so the person's preferred one can be chosen.
        const location = [].concat(post.jobLocation || []).map((l) => [l.address?.addressLocality, l.address?.addressRegion, l.address?.addressCountry?.name || l.address?.addressCountry].filter((x) => typeof x === 'string' && x).join(', ')).filter(Boolean).join('; ');
        return { title: post.title || document.title, company: post.hiringOrganization?.name || '', location, jd: jd.slice(0, JD_CHARS), structured: true };
      } catch {}
    }
    // Pages on a known applicant-tracking host count even when nothing in the address or title says "job".
    if (!ATS.test(location.href + ' ' + document.title) && !ATS_HOST.test(location.hostname)) return null;
    const text = AM.norm((document.querySelector('main,article,[role=main]') || document.body)?.innerText);
    // Most postings show the location in an element named for it, near the title.
    const place = [...document.querySelectorAll('[class*="location" i]')].find((e) => !e.closest('form,label,nav,footer') && !e.querySelector('input,select,textarea') && e.getBoundingClientRect().height > 0 && /^.{3,90}$/.test(AM.norm(e.textContent)));
    if (text.length >= 800) {
      // Long pages open with company blurb; start the excerpt near the role itself.
      const at = text.search(/about the (role|job|position)|responsibilit|what you.?ll (do|be doing)|the role\b|your role/i);
      const start = at > 1500 ? at - 200 : 0;
      const signs = [/responsibilit/i, /qualification/i, /requirement/i, /what you.?ll (do|bring|need)/i, /about the (role|job|position)/i, /you (will|have|are)\b/i, /we.?re looking for/i, /\d\+? years/i, /experience (with|in|building)/i].filter((re) => re.test(text)).length;
      return { title: document.title, company: '', location: place ? AM.norm(place.textContent) : '', jd: text.slice(start, start + JD_CHARS), postingLike: signs >= 3 };
    }
    // An application step with no description on it: still report the page, so the
    // posting can be looked up from its address.
    return /greenhouse\.io|myworkdayjobs|myworkdaysite/.test(location.hostname) || /[?&]gh_jid=/.test(location.search) ? { title: document.title, company: '', location: '', jd: '' } : null;
  }

  // Lets tests exercise the background-tab timing path in a visible tab.
  chrome.storage.local.get('settings').then(({ settings }) => (AM.workerTimers = !!settings?.workerTimers), () => {});

  let running = false;
  let rerun = false;
  // What earlier passes did on this page, so a later pass (new questions appeared)
  // still shows who filled each field instead of "already had a value".
  const done = new Map();
  const doneKey = (f) => `${f.section}|${f.label}|${f.kind}`;
  let attached = null;

  const run = guarded(async function () {
    if (running) return void (rerun = true);
    running = true;
    runCount++;
    await remembered;
    try {
      const { profile, answers = {}, resume, settings = {} } = await chrome.storage.local.get(['profile', 'answers', 'resume', 'settings']);
      const started = Date.now();
      const fields = AM.scan();
      if (!fields.length) return;
      if (!profile) return void send({ type: 'report', error: 'No profile yet. Open settings (the gear) and add your details.' });
      const ai = !!settings.apiKey || settings.answerProvider === 'local';
      // Tells the panel which job description everything is being based on.
      if (settings.apiKey && isTop) send({ type: 'job-status' });
      send({ type: 'progress', text: `Reading ${fields.length} fields…` });
      // When this application uses the job's location, the address fields follow it,
      // the same as the two location spots on the tailored resume.
      const where = (await send({ type: 'apply-location' }))?.where;
      const home = profile.address || {};
      if (where) profile.address = { line1: where.line1, line2: '', city: where.city, state: where.state, postal_code: where.postal_code, country: where.country };
      // A "Country" box sitting right before the phone number picks the phone's dialling
      // country, which stays the person's own whatever location the application uses.
      const phoneCountry = new Set(fields.filter((f, i) => /^country\b/i.test(f.label) && /phone|mobile/i.test(fields[i + 1]?.label || '')));

      const counts = { resumeField: AM.resumeField(fields), preferAI: ai };
      const rows = new Map();
      const row = (f, status, extra = {}) => {
        const r = { id: f.id, kind: f.kind, label: f.label || 'Resume', required: f.required, status, ...extra };
        rows.set(f.id, r);
        // Once a question has an outcome it has had its one automatic pass.
        if (status !== 'working') attempted.add(f.label);
        if (status === 'filled' || status === 'review') done.set(doneKey(f), r);
        if (f === counts.resumeField && done.has(doneKey(f))) attached = { el: f.el, row: r };
      };
      const report = () => {
        // Some sites swap the upload box for a file chip once a resume is attached.
        const gone = attached && !attached.el.isConnected ? [attached.row] : [];
        send({ type: 'report', ms: Date.now() - started, rows: [...gone, ...fields.map((f) => rows.get(f.id)).filter(Boolean)] });
      };

      const written = [];
      async function fillOne(f, p) {
        // Answered by the person while the AI was thinking: theirs stands.
        // The page moved on (next step, submitted) while this fill was in progress.
        if (!f.el.isConnected) return;
        const typed = f.kind !== 'file' && AM.currentValue(f);
        // (A pre-filled value being replaced is expected to still be there.)
        if (typed && typed !== p.replace) return void row(f, 'kept', { value: typed });
        let ok = false;
        let note;
        attempted.add(f.label);
        send({ type: 'filling', key: pageKey, label: f.label });
        try {
          ok = await AM.fill(f, p.values, { resume: p.file, choose });
        } catch (e) {
          note = `Could not fill: ${e.message}`;
        }
        const shown = f.kind === 'file' ? p.file?.name : p.values.join(' | ');
        // Record what the extension itself wrote, so only the person's later edits count as theirs.
        if (ok) seen.set(f.el, AM.currentValue(f));
        if (ok && f.kind !== 'file') written.push([f, p]);
        if (ok) row(f, p.review ? 'review' : 'filled', { value: (f.kind !== 'file' && AM.currentValue(f)) || shown, source: p.source, ...p.extra });
        else if (f.kind === 'file') row(f, 'manual', { note: 'Upload a resume in settings to attach it automatically.' });
        else row(f, 'failed', { note: note || `No matching option for “${shown}”` });
      }

      // Lets a dropdown ask the AI to choose among the options it is showing.
      const choose = ai ? async (f, options, want) => (await send({ type: 'choose', label: f.label, section: f.section, want, options }))?.choice || '' : null;
      const ready = [];
      const pending = [];
      // Role-description boxes in numbered work-experience blocks, filled from the tailored resume.
      const roleFields = [];
      counts.where = where;
      let resumeField = null;

      for (const f of fields) {
        if (skip.has(f.label)) { row(f, 'manual', { note: 'Changing this reloads the page, so it is left for you.' }); continue; }
        const cur = AM.currentValue(f);
        // A value the site itself put there (carried over from an earlier application) is
        // replaced when this application has a different answer for it. Values typed by
        // the person, or already written by the extension, are never touched.
        const stale = cur && settings.replacePrefilled !== false && !byPerson.has(f.el) && !done.has(doneKey(f)) && f.kind !== 'file' && f.kind !== 'checkboxes' && f.kind !== 'checkbox';
        if (cur && !stale) {
          const prev = attached?.el === f.el ? attached.row : done.get(doneKey(f));
          if (prev) rows.set(f.id, { ...prev, id: f.id, value: prev.kind === 'file' ? prev.value : cur });
          else row(f, 'kept', { value: cur });
          continue;
        }
        if (stale) {
          const fresh = (where && AM.isLocation(f) ? null : AM.saved(answers[AM.key(f)])) || (() => {
            const r = phoneCountry.has(f) ? null : AM.rule(f, profile, counts);
            if (r?.role !== undefined) roleFields.push([f, r.role, cur]);
            return r?.value && !r.sensitive ? [r.value] : null;
          })();
          const same = fresh && (HAS_OPTIONS.has(f.kind) ? f.options[AM.pick(f.options, fresh[0])] === cur : AM.canon(fresh[0]) === AM.canon(cur));
          if (fresh && !same && !(HAS_OPTIONS.has(f.kind) && AM.pick(f.options, fresh[0]) < 0)) ready.push([f, { values: fresh, source: 'profile', replace: cur }]);
          else row(f, 'kept', { value: cur });
          continue;
        }
        const saved = where && AM.isLocation(f) ? null : AM.saved(answers[AM.key(f)]);
        if (saved) { ready.push([f, { values: saved, source: 'saved' }]); continue; }
        // A direct question about where the person lives today is answered by the AI
        // from their real address, not from the location this application uses.
        const asksHome = where && /where (are|do) you|currently (based|located|living|live|reside)/i.test(f.label);
        const r = asksHome ? null : phoneCountry.has(f) ? { value: profile.phone_country || home.country || 'United States' } : AM.rule(f, profile, counts);
        if (where && !asksHome && !r?.value && !r?.manual && AM.isLocation(f)) {
          // A street address is never made up; it is filled only if the person saved one for this city.
          row(f, 'needs', { note: `Left empty for ${where.label}. Save a value under "Locations you apply from" in settings to have it filled.` });
        } else if (r?.role !== undefined) roleFields.push([f, r.role, '']);
        else if (r?.manual) row(f, 'manual', { note: r.manual });
        else if (f.kind === 'file') resumeField = f;
        else if (r?.value && HAS_OPTIONS.has(f.kind) && AM.pick(f.options, r.value) < 0) {
          if (r.sensitive) row(f, 'manual', { note: `No option matches your saved answer “${r.value}”` });
          else pending.push(f);
        } else if (r?.value) ready.push([f, { values: [r.value], source: 'profile' }]);
        else pending.push(f);
      }

      // Kick off the slow work first so it overlaps with the instant fills.
      // The tailored resume is started first. On portals that spread the application over
      // several pages it starts on the very first page, so it is ready (and remembered
      // for the job) by the time the experience and resume page comes up.
      const tailoring = (resumeField || roleFields.length || MULTI_STEP.test(location.hostname)) && settings.apiKey && settings.tailor !== false ? send({ type: 'tailor' }) : null;
      for (const [f] of roleFields) row(f, 'working', { note: tailoring ? 'Waiting for the tailored resume…' : '' });
      if (resumeField) row(resumeField, 'working', { note: tailoring ? 'Tailoring your resume to this job…' : '' });

      let asking = null;
      if (pending.length && ai) {
        for (const f of pending) {
          if (f.kind === 'combobox' && !f.options) await AM.harvest(f);
          row(f, 'working', { note: 'Thinking…' });
        }
        asking = send({ type: 'map', fields: pending.map(serialize), page: pageContext() });
      } else {
        for (const f of pending) row(f, 'needs', { note: 'Custom question. Add an API key in settings to have AI answer it.' });
      }

      for (const [f, p] of ready) await fillOne(f, p);
      report();

      if (asking) {
        const res = await asking;
        const got = new Map((res?.answers || []).map((a) => [a.id, a]));
        for (const f of pending) {
          const a = got.get(f.id);
          const values = (a?.values || []).filter(Boolean);
          if (res?.error || !res) row(f, 'needs', { note: `AI unavailable: ${res?.error || 'no response'}` });
          else if (values.length) await fillOne(f, { values, source: 'ai', review: !a.confident || AM.isWorkAuth(f) });
          else row(f, 'needs', { note: 'Your profile does not answer this one.' });
        }
        report();
      }

      // Work-experience descriptions follow the tailored resume, so the form and the
      // attached PDF say the same thing. Without a tailored version they are left as they are.
      if (roleFields.length) {
        const text = tailoring && (await tailoring)?.text;
        for (const [f, n, was] of roleFields) {
          const bullets = text?.experience?.find((e) => e.index === n)?.bullets;
          if (bullets?.length) await fillOne(f, { values: [bullets.map((b) => `\u2022 ${b.replace(/\*\*/g, '')}`).join('\n')], source: 'ai', review: true, replace: was });
          else if (was) row(f, 'kept', { value: was });
          else row(f, 'needs', { note: 'No tailored resume for this job, so this description is left for you.' });
        }
        report();
      }

      if (resumeField) {
        const made = tailoring && (await tailoring);
        if (made?.base64) await fillOne(resumeField, { values: [], file: made, source: 'ai', review: true, extra: { note: `${made.name} (tailored, click to preview)`, preview: made.key } });
        else {
          await fillOne(resumeField, { values: [], file: resume, source: 'profile' });
          const r = rows.get(resumeField.id);
          if (made?.error && r.status === 'filled') r.note = `${resume.name} (original; tailoring failed: ${made.error})`;
        }
      }
      report();

      // Check the work in the background, without holding up the next page.
      checkWork(written, row, report, choose);
    } catch (e) {
      send({ type: 'report', error: `Something went wrong: ${e.message}` });
    } finally {
      running = false;
      send({ type: 'run-done', key: pageKey, labels: [...attempted], auto: autoPass });
      autoPass = false;
      schedule();
      for (const f of AM.fields || []) if (!seen.has(f.el)) seen.set(f.el, AM.currentValue(f));
      // Edits made while the fill was still running are picked up now.
      if (saveLater) autoSave();
      if (rerun) {
        rerun = false;
        schedule();
      }
    }
  });

  // Some forms finish setting themselves up (or read the uploaded resume) a few seconds
  // in and wipe what was filled earlier, and some never register an answer even though
  // it is on screen. Anything lost is filled once more; anything still not registered
  // is flagged instead of being shown as done. Stops as soon as another fill starts.
  let runCount = 0;
  let checking = false;
  async function checkWork(written, row, report, choose) {
    const mine = runCount;
    for (const wait of [1500, 3500]) {
      await AM.sleep(wait);
      if (mine !== runCount || !AM.alive() || !written.some(([f]) => f.el.isConnected)) return;
      let changed = false;
      checking = true;
      try {
        for (const [f, p] of written) {
          if (!f.el.isConnected) continue;
          const lost = () => !AM.currentValue(f) || AM.unregistered(f);
          if (!lost()) continue;
          changed = true;
          await AM.fill(f, p.values, { choose }).catch(() => false);
          await AM.sleep(150);
          if (lost()) row(f, 'failed', { note: 'The form did not keep this answer. Click the field and retype it.' });
          else seen.set(f.el, AM.currentValue(f));
        }
      } finally {
        checking = false;
      }
      if (changed && mine === runCount) report();
    }
  }

  // What each field held the last time the extension looked, so a later difference
  // can only be the person's own edit.
  const seen = new WeakMap();
  // Fields the person has edited themselves. A value in any other field that the
  // extension did not write was put there by the site.
  const byPerson = new WeakSet();
  let saving = false;
  let saveLater = false;

  // Saves answers the person gives by hand, with no button press. They fill the same
  // question directly next time, and go to the AI as examples for reworded versions.
  const autoSave = guarded(async function () {
    saveLater = running || checking;
    if (running || checking || saving || !AM.fields) return;
    saving = true;
    try {
      await AM.sleep(600);
      if (!AM.alive()) return;
      const edited = AM.fields.filter((f) => {
        if (!f.el.isConnected || f.kind === 'file' || f.kind === 'checkbox') return false;
        const cur = AM.currentValue(f);
        const changed = cur && cur !== seen.get(f.el);
        seen.set(f.el, cur);
        if (changed) byPerson.add(f.el);
        return changed;
      });
      if (!edited.length || running || checking) return;
      const { profile = {}, answers = {} } = await chrome.storage.local.get(['profile', 'answers']);
      const counts = { resumeField: null };
      for (const f of edited) {
        const r = AM.rule(f, profile, counts);
        // Consent and demographic choices are only remembered when asked to ("Save answers").
        if (r?.manual || r?.sensitive) continue;
        const cur = AM.currentValue(f);
        answers[AM.key(f)] = { q: f.label, a: f.kind === 'checkboxes' ? cur.split(' | ') : cur, at: Date.now() };
      }
      await chrome.storage.local.set({ answers });
    } finally {
      saving = false;
    }
  });
  for (const type of ['change', 'click', 'focusout']) document.addEventListener(type, (e) => e.isTrusted && autoSave(), true);

  // Remembers everything on the page the profile cannot answer, demographic choices included.
  const learn = guarded(async function () {
    const { profile = {}, answers = {} } = await chrome.storage.local.get(['profile', 'answers']);
    const counts = { resumeField: null };
    let count = 0;
    for (const f of AM.scan()) {
      if (f.kind === 'file' || f.kind === 'checkbox') continue;
      const cur = AM.currentValue(f);
      const r = AM.rule(f, profile, counts);
      if (!cur || (r?.value && !r.sensitive)) continue;
      answers[AM.key(f)] = { q: f.label, a: f.kind === 'checkboxes' ? cur.split(' | ') : cur, at: Date.now(), ...(r?.sensitive ? { private: true } : {}) };
      count++;
    }
    if (!count) return;
    await chrome.storage.local.set({ answers });
    send({ type: 'learned', count });
  });

  // Whether this frame is showing a job application form. The extension stays silent
  // everywhere else: mail, search pages, sign-in forms, social sites. It takes real
  // evidence, not a stray upload button or the word "job" in an address:
  //  - the frame is served by a known applicant-tracking system, or
  //  - the form asks for a name and email or phone AND for a resume, or
  //  - it asks for three identity details on a page that says it is an application.
  const ATS_HOST = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|myworkdayjobs\.com|myworkdaysite\.com|workday\.com|icims\.com|smartrecruiters\.com|gem\.com|jobvite\.com|bamboohr\.com|taleo\.net|oraclecloud\.com|successfactors\.com|recruitee\.com|teamtailor\.com|breezy\.hr|rippling\.com|paylocity\.com|adp\.com|ultipro\.com|dayforcehcm\.com|eightfold\.ai|phenompeople\.com|avature\.net|pinpointhq\.com|applytojob\.com)$/i;
  const IDENTITY = /^((first|last|full|legal|given|family|preferred) )?name\b|^e ?mail|^(mobile |cell )?phone|^mobile\b/;
  let recognised = false;
  function isApplication(fields) {
    if (fields.length < 3) return false;
    // Later steps of a form already recognised in this page stay recognised.
    if (recognised) return true;
    const labels = fields.map((f) => AM.canon(f.label));
    const identity = labels.filter((l) => l.split(' ').length <= 4 && IDENTITY.test(l)).length;
    const resume = fields.some((f) => f.kind === 'file' && /resume|\bcv\b|curriculum/i.test(`${f.label} ${f.hint}`));
    const saysSo = ATS.test(location.pathname + ' ' + document.title);
    recognised = ATS_HOST.test(location.hostname) || (identity >= 2 && resume) || (identity >= 3 && fields.length >= 5 && saysSo);
    return recognised;
  }

  // A company's own careers page often shows the job through an embedded board, with
  // only an id in the address. These are the addresses of the actual posting, worked
  // out from that id and from the board the page loads.
  function postingHints() {
    const out = [];
    const q = new URLSearchParams(location.search);
    const src = (sel) => [...document.querySelectorAll(sel)].map((e) => e.src || e.getAttribute('src') || '');
    const ashby = q.get('ashby_jid');
    const ashbyOrg = src('script[src*="jobs.ashbyhq.com/"],iframe[src*="jobs.ashbyhq.com/"]').map((u) => u.match(/jobs\.ashbyhq\.com\/([^/?#]+)/)?.[1]).find(Boolean);
    if (ashby && ashbyOrg) out.push(`https://jobs.ashbyhq.com/${ashbyOrg}/${ashby}`);
    const gh = q.get('gh_jid');
    const ghBoard = src('script[src*="greenhouse.io/embed"],iframe[src*="greenhouse.io/embed"]').map((u) => u.match(/[?&]for=([^&#]+)/)?.[1]).find(Boolean);
    if (gh && ghBoard) out.push(`https://job-boards.greenhouse.io/${ghBoard}/jobs/${gh}`);
    const lever = q.get('lever-id') || q.get('lever_id');
    const leverOrg = src('script[src*="lever.co/"],iframe[src*="jobs.lever.co/"]').map((u) => u.match(/lever\.co\/(?:v0\/postings\/)?([^/?#]+)/)?.[1]).find(Boolean);
    if (lever && leverOrg) out.push(`https://jobs.lever.co/${leverOrg}/${lever}`);
    for (const u of src('iframe[src*="jobs.ashbyhq.com/"],iframe[src*="greenhouse.io/"],iframe[src*="jobs.lever.co/"]')) out.push(u);
    return [...new Set(out)];
  }
  // After the person points to the right posting: rebuild the resume against it and swap
  // it in, along with the work-experience descriptions, without touching anything else.
  const retailor = guarded(async function () {
    const fields = AM.scan();
    const resumeField = AM.resumeField(fields);
    const { profile = {}, settings = {} } = await chrome.storage.local.get(['profile', 'settings']);
    if (!settings.apiKey || settings.tailor === false) return;
    if (!resumeField && !fields.some((f) => /work experience \d/i.test(f.section))) return;
    send({ type: 'progress', text: 'Rewriting your resume for this job…' });
    const made = await send({ type: 'tailor' });
    if (!made?.base64) return void send({ type: 'report', error: `Could not tailor the resume: ${made?.error || 'no response'}` });
    if (resumeField) await AM.fill(resumeField, [], { resume: made });
    for (const f of fields) {
      const r = AM.rule(f, profile, { resumeField: null });
      const bullets = r?.role !== undefined && made.text?.experience?.find((e) => e.index === r.role)?.bullets;
      if (bullets?.length) await AM.fill(f, [bullets.map((b) => `\u2022 ${b.replace(/\*\*/g, '')}`).join('\n')]);
    }
    send({ type: 'learned', count: 0, note: `Resume rewritten for this job and attached (${made.name}).` });
  });
  let hinted = false;
  let waitingForJob = false;
  let proceedWithoutJob = false;

  let lastJob = '';
  // Questions that have already had their one automatic pass. After that the page is
  // left alone (so your own edits stand) unless you press Fill again.
  const attempted = new Set();
  let autoRuns = 0;
  let autoPass = false;
  // What earlier loads of this same page already did (see "Auto-fill memory" in background.js).
  const pageKey = location.origin + location.pathname;
  let skip = new Set();
  let interrupted = false;
  let passes = 0;
  const remembered = send({ type: 'auto-state', key: pageKey }).then((st) => {
    for (const l of st?.labels || []) attempted.add(l);
    skip = new Set(st?.skip || []);
    interrupted = !!st?.interrupted;
    passes = st?.passes || 0;
  });
  let settleSince = 0;

  // Tracker: a submit click is reported, then confirmed by the page saying so or the form going away.
  const SUBMIT = /^(submit|submit (my )?application|send( my)? application|apply|apply now|complete application|finish)$/i;
  const CONFIRM = /thank you for (applying|your application|submitting)|thanks for applying|application (has been |was |is )?(successfully )?(submitted|received|sent)|(we|we've|we have) received your application|successfully (applied|submitted)/i;
  let submittedAt = 0;
  let loadedAt = Date.now();
  let checkedUrl = '';
  let alreadyApplied = false;

  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('button,input[type=submit],[role=button]');
    if (!b || !SUBMIT.test(AM.norm(b.textContent || b.value)) || (AM.fields?.length || 0) < 3) return;
    submittedAt = Date.now();
    send({ type: 'submitting' });
    for (const ms of [2500, 6000, 12000]) AM.sleep(ms).then(detect);
  }, true);

  const detect = guarded(async function () {
    if (running) {
      // A fill is still being checked, but a submit must still be noticed promptly.
      if (Date.now() - submittedAt < 120000) {
        const gone = document.querySelectorAll('input,select,textarea').length < 3;
        send({ type: 'detected', count: gone ? 0 : AM.fields?.length || 0, confirmed: CONFIRM.test(document.body?.innerText.slice(0, 20000) || ''), submitter: true });
      }
      return;
    }
    const fields = document.querySelectorAll('input,select,textarea').length < 3 ? [] : AM.scan();
    for (const f of fields) {
      if (seen.has(f.el)) continue;
      seen.set(f.el, AM.currentValue(f));
    }

    if (isTop) {
      const hints = postingHints();
      const job = jobInfo() || (hints.length ? { title: document.title, company: '', location: '', jd: '' } : null);
      const sig = job && `${location.href}|${job.jd.length}|${hints.length}`;
      if (job && sig !== lastJob) {
        lastJob = sig;
        send({ type: 'job', url: location.href, fields: fields.length, hints, ...job });
      }
    } else if (!hinted && /jobs\.ashbyhq\.com|greenhouse\.io|jobs\.(eu\.)?lever\.co|myworkdayjobs/.test(location.hostname)) {
      // An embedded job board knows exactly which posting it is showing.
      hinted = true;
      send({ type: 'job-hint', url: location.href });
    }

    const count = isApplication(fields) ? fields.length : 0;
    const submitter = Date.now() - submittedAt < 120000;
    // Only read the page text when a submit may just have happened (here, or before a navigation).
    const confirmed = (submitter || Date.now() - loadedAt < 15000) && CONFIRM.test(document.body?.innerText.slice(0, 20000) || '');
    send({ type: 'detected', count, confirmed, submitter });

    if ((count || (isTop && lastJob)) && checkedUrl !== location.href) {
      checkedUrl = location.href;
      alreadyApplied = !!(await send({ type: 'applied?' }))?.entry;
    }
    if (!count || alreadyApplied) return;

    // A new page of a multi-step form shows mostly questions not seen before; that gets
    // one automatic pass. A page that merely changed a little does not.
    await remembered;
    const fresh = fields.filter((f) => !attempted.has(f.label) && !skip.has(f.label)).length;
    // After a reload cut a pass short, carry on with whatever is left; otherwise only a mostly-new page counts.
    const enough = interrupted ? 1 : Math.min(3, Math.ceil(fields.length / 2));
    if (fresh < enough || autoRuns >= 8 || passes + autoRuns >= 10) return;
    const { settings = {}, profile } = await chrome.storage.local.get(['settings', 'profile']);
    if (settings.autoFill === false || !profile) return;
    // The resume and the written answers are only as good as the job description behind
    // them. If none can be found for this application, say so and wait rather than fill
    // against nothing; "Fill without it" in the panel overrides.
    if (settings.apiKey && settings.tailor !== false && !proceedWithoutJob) {
      const status = await send({ type: 'job-status' });
      if (status && !status.ok) {
        waitingForJob = true;
        return void send({ type: 'need-job', count });
      }
      waitingForJob = false;
    }
    // Wait until the page has finished loading and stopped rearranging itself, so the
    // form's own start-up does not wipe what gets filled. Give up waiting after 6 s.
    const settled = document.readyState === 'complete' && Date.now() - lastChange > 700;
    if (!settled) {
      settleSince ||= Date.now();
      if (Date.now() - settleSince < 6000) return void AM.sleep(400).then(detect);
    }
    settleSince = 0;
    autoRuns++;
    autoPass = true;
    run();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!AM.alive()) return;
    if (msg.type === 'retailor') retailor();
    else if (msg.type === 'job-found') {
      // The description turned up (the person opened the posting): carry on.
      if (waitingForJob) schedule();
      AM.panel?.handle(msg);
    } else if (msg.type === 'run') {
      alreadyApplied = false;
      proceedWithoutJob = true;
      run();
    } else if (msg.type === 'applied-now') {
      checkedUrl = '';
      AM.panel?.handle(msg);
    }
    else if (msg.type === 'learn') learn();
    else if (msg.type === 'focus' && msg.frame === AM.frame) {
      const el = AM.fields?.find((f) => f.id === msg.id)?.el;
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el?.focus({ preventScroll: true });
    } else AM.panel?.handle(msg);
  });

  // Look again shortly after the page stops changing, but never wait more than
  // 1.2 s on a page that keeps changing. One timer at a time.
  let due = 0;
  let first = 0;
  let waiting = false;
  async function schedule() {
    const now = Date.now();
    first ||= now;
    due = Math.min(now + 300, first + 1200);
    if (waiting) return;
    waiting = true;
    while (Date.now() < due) await AM.sleep(Math.max(20, due - Date.now()));
    waiting = false;
    first = 0;
    if (!AM.alive()) return void observer.disconnect();
    detect();
  }
  let lastChange = Date.now();
  const observer = new MutationObserver(() => {
    lastChange = Date.now();
    schedule();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  schedule();
})();
