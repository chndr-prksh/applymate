// The floating assistant shown on the top frame: a launcher pill that opens into
// a list of what was filled and what still needs the person.
(() => {
  const AM = (globalThis.__AM ||= {});
  if (window.top !== window) return;

  const CSS_TEXT = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .wrap { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; color: #e8eaed; font-size: 13px; line-height: 1.35; }
    .pill.warn { border-color: #d29922; }
    .pill, .head { cursor: grab; user-select: none; touch-action: none; }
    .wrap.dragging .pill, .wrap.dragging .head { cursor: grabbing; }
    .pill { display: flex; align-items: center; gap: 8px; background: #1f2328; border: 1px solid #3a3f47; border-radius: 999px;
      padding: 8px 8px 8px 14px; box-shadow: 0 6px 24px rgba(0,0,0,.28); }
    .card { width: 340px; max-height: min(70vh, 560px); display: flex; flex-direction: column; background: #1f2328;
      border: 1px solid #3a3f47; border-radius: 12px; box-shadow: 0 10px 36px rgba(0,0,0,.35); overflow: hidden; }
    .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #30353c; }
    .title { font-weight: 600; flex: 1; }
    .sub { color: #9aa3ad; }
    .list { overflow-y: auto; padding: 4px 0; }
    .group { padding: 8px 12px 2px; color: #9aa3ad; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
    .row { display: grid; grid-template-columns: 8px 1fr; gap: 8px; padding: 6px 12px; cursor: pointer; }
    .row:hover { background: #2a2f36; }
    .dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 5px; background: #3fb950; }
    .dot.working { background: #8b949e; animation: pulse 1s infinite alternate; } @keyframes pulse { to { opacity: .3; } }
    .dot.needs, .dot.manual { background: #d29922; } .dot.failed { background: #f85149; } .dot.review { background: #58a6ff; } .dot.kept { background: #6e7681; }
    .q { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .a { color: #9aa3ad; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .foot { display: flex; gap: 6px; padding: 10px 12px; border-top: 1px solid #30353c; }
    button { all: unset; cursor: pointer; padding: 6px 12px; border-radius: 8px; background: #2f81f7; color: #fff; font-size: 13px; font-weight: 600; }
    button.ghost { background: transparent; color: #c9d1d9; border: 1px solid #3a3f47; font-weight: 500; }
    button.icon { padding: 4px 8px; background: transparent; color: #9aa3ad; font-weight: 400; }
    button:focus-visible { outline: 2px solid #58a6ff; outline-offset: 1px; }
    .msg { padding: 12px; color: #c9d1d9; }
  `;

  const h = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  const VERSION = chrome.runtime.getManifest().version;
  let needJob = false;
  let job = null; // { ok, title, company, source } of the description in use
  let editingJob = false;
  let jobMsg = '';
  let wrap, count = 0, open = false, busy = '', error = '', note = '', already = null;
  const day = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const frames = new Map();
  const detected = new Map();

  function mount() {
    if (wrap) return;
    const host = document.createElement('div');
    host.setAttribute('data-applymate', '');
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS_TEXT;
    wrap = h('div', 'wrap');
    root.append(style, wrap);
    document.documentElement.append(host);
    makeDraggable();
  }

  // The pill and the panel header can be dragged anywhere; the spot is remembered.
  let pos = { right: 16, bottom: 16 };
  function place() {
    const r = wrap.getBoundingClientRect();
    pos.right = Math.max(4, Math.min(pos.right, innerWidth - r.width - 4));
    pos.bottom = Math.max(4, Math.min(pos.bottom, innerHeight - r.height - 4));
    wrap.style.right = `${pos.right}px`;
    wrap.style.bottom = `${pos.bottom}px`;
  }

  function makeDraggable() {
    AM.safe(() => chrome.storage.local.get('panelPos'), {}).then(({ panelPos }) => {
      if (panelPos) pos = panelPos;
      place();
    });
    let from = null;
    wrap.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button') || !e.target.closest('.pill,.head')) return;
      from = { x: e.clientX, y: e.clientY, ...pos };
      wrap.setPointerCapture(e.pointerId);
      wrap.classList.add('dragging');
    });
    wrap.addEventListener('pointermove', (e) => {
      if (!from) return;
      pos = { right: from.right - (e.clientX - from.x), bottom: from.bottom - (e.clientY - from.y) };
      place();
    });
    const drop = () => {
      if (!from) return;
      from = null;
      wrap.classList.remove('dragging');
      AM.safe(() => chrome.storage.local.set({ panelPos: pos }));
    };
    wrap.addEventListener('pointerup', drop);
    wrap.addEventListener('pointercancel', drop);
    window.addEventListener('resize', place);
  }

  // After the extension is reloaded, this tab's copy is cut off until the page is refreshed.
  const act = (type) => () => {
    if (AM.alive()) return AM.safe(() => chrome.runtime.sendMessage({ type }));
    error = 'ApplyMate was updated. Refresh this page to keep using it.';
    open = true;
    render();
  };

  function button(label, cls, onClick) {
    const b = h('button', cls, label);
    b.addEventListener('click', onClick);
    return b;
  }

  function render() {
    mount();
    wrap.replaceChildren();
    if (!open && already) {
      // Seen this job before: warn, and only fill if the person asks to apply again.
      const pill = h('div', 'pill warn');
      pill.append(h('span', '', `You applied to this job on ${day(already.appliedAt)}`));
      if (count) pill.append(button('Apply again', '', () => { already = null; open = true; act('apply-again')(); render(); }));
      pill.append(button('✕', 'icon', () => { already = null; render(); }));
      wrap.append(pill);
      return;
    }
    if (!open) {
      if (!count) return;
      const pill = h('div', 'pill');
      pill.append(h('span', '', `${count} fields found`), button('Fill', '', () => { open = true; act('run-tab')(); render(); }));
      wrap.append(pill);
      return;
    }
    const rows = [...frames.values()].flat();
    const needs = rows.filter((r) => ['needs', 'manual', 'failed'].includes(r.status));
    const done = rows.filter((r) => ['filled', 'review'].includes(r.status));
    const kept = rows.filter((r) => r.status === 'kept');
    const working = rows.filter((r) => r.status === 'working');

    const card = h('div', 'card');
    const head = h('div', 'head');
    head.append(h('span', 'title', `ApplyMate ${VERSION}`), h('span', 'sub', busy || (rows.length ? `${done.length} filled · ${needs.length} for you` : '')));
    head.append(button('⚙', 'icon', act('open-options')), button('✕', 'icon', () => { open = false; render(); }));
    card.append(head);

    // Which posting the resume and answers are based on, with a way to correct it.
    const SOURCES = { listing: 'from the job board', structured: 'from the posting page', page: 'read from the page', pasted: 'pasted by you' };
    if (job?.ok && !needJob) {
      const line = h('div', 'msg');
      line.style.paddingBottom = '0';
      line.append(h('span', 'sub', `Job: ${[job.title, job.company].filter(Boolean).join(' · ')} (${SOURCES[job.source] || 'found'}) `));
      const change = h('button', 'icon', editingJob ? 'cancel' : 'wrong job?');
      change.style.textDecoration = 'underline';
      change.addEventListener('click', () => { editingJob = !editingJob; jobMsg = ''; render(); });
      line.append(change);
      card.append(line);
    }
    if (needJob || editingJob) {
      // The person points to the posting: a link, or failing that the text itself.
      const box = h('div', 'msg');
      box.append(h('div', 'sub', needJob ? '' : 'Paste the link of the right job posting, or its description:'));
      const link = h('input');
      link.placeholder = 'https://… link to the job posting';
      link.style.cssText = 'width:100%;margin:6px 0;padding:6px 8px;border-radius:6px;border:1px solid #3a3f47;background:#0d1117;color:#e6edf3;font:inherit;box-sizing:border-box';
      const text = h('textarea');
      text.placeholder = 'or paste the job description text here';
      text.style.cssText = link.style.cssText + ';height:70px;resize:vertical';
      const go = button('Use this posting', '', async () => {
        jobMsg = 'Reading the posting…';
        render();
        const res = AM.alive() && (await chrome.runtime.sendMessage(link.value.trim() ? { type: 'set-job-link', url: link.value.trim() } : { type: 'set-job-text', text: text.value }).catch(() => null));
        jobMsg = res?.ok ? `Using “${res.title || 'the pasted description'}”. Rewriting your resume…` : res?.reason || 'Something went wrong.';
        if (res?.ok) { editingJob = false; needJob = false; }
        render();
      });
      box.append(link, text, go);
      if (jobMsg) box.append(h('div', 'sub', jobMsg));
      card.append(box);
    }
    if (needJob) {
      // No description could be found for this application; ask the person to show it.
      const ask = h('div', 'msg');
      ask.append(h('div', '', "I couldn't find the job description for this application, so I haven't filled anything yet."));
      ask.append(h('div', 'sub', 'Paste the posting link (or its text) above, or open the job posting page in this tab or another one, and I will carry on by myself.'));
      const row = h('div', 'foot');
      row.style.padding = '10px 0 0';
      row.append(button('Fill without it', 'ghost', () => { needJob = false; act('run-tab')(); render(); }));
      ask.append(row);
      card.append(ask);
    }
    if (error) card.append(h('div', 'msg', error));
    else if (note) card.append(h('div', 'msg', note));
    const list = h('div', 'list');
    const section = (title, items) => {
      if (!items.length) return;
      list.append(h('div', 'group', title));
      for (const r of items) {
        const row = h('div', 'row');
        const body = h('div');
        body.style.minWidth = '0';
        body.append(h('div', 'q', r.label + (r.required ? ' *' : '')), h('div', 'a', r.note || r.value || ''));
        row.append(h('span', `dot ${r.status}`), body);
        row.title = `${r.label}\n${r.note || r.value || ''}`;
        row.addEventListener('click', () => AM.safe(() => chrome.runtime.sendMessage(r.preview ? { type: 'preview', key: r.preview } : { type: 'focus', frame: r.frame, id: r.id })));
        list.append(row);
      }
    };
    section('Working on', working);
    section('Needs you', needs);
    section('Filled', done);
    section('Already had a value', kept);
    card.append(list);

    const foot = h('div', 'foot');
    foot.append(button('Fill again', '', act('run-tab')), button('Save answers', 'ghost', act('learn-tab')), button('Mark applied', 'ghost', act('mark-applied')));
    card.append(foot);
    wrap.append(card);
    place();
  }

  AM.panel = {
    handle(msg) {
      if (msg.type === 'detected') {
        detected.set(msg.frame, msg.count);
        count = [...detected.values()].reduce((a, b) => a + b, 0);
      }
      else if (msg.type === 'progress') { busy = msg.text; error = ''; note = ''; open = true; needJob = false; }
      else if (msg.type === 'report') {
        busy = '';
        if (msg.error) error = msg.error;
        else frames.set(msg.frame, msg.rows.map((r) => ({ ...r, frame: msg.frame })));
        open = true;
      } else if (msg.type === 'job-info') { job = msg; if (msg.ok && jobMsg.startsWith('Reading')) jobMsg = ''; }
      else if (msg.type === 'need-job') { needJob = true; open = true; error = ''; }
      else if (msg.type === 'job-found') { if (!needJob) return; needJob = false; note = 'Found the job description. Filling now.'; }
      else if (msg.type === 'already') { already = msg.entry; open = false; }
      else if (msg.type === 'applied-now') { note = `Saved to your tracker as applied on ${day(msg.entry.appliedAt)}.`; open = true; }
      else if (msg.type === 'learned' && msg.note) { note = msg.note; busy = ''; open = true; }
      else if (msg.type === 'learned') note = `Saved ${msg.count} answer${msg.count === 1 ? '' : 's'} for next time.`;
      else return;
      render();
    },
  };
})();
