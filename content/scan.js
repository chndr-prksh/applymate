// Reads the form on screen into a flat list of field descriptors.
(() => {
  const AM = (globalThis.__AM ||= {});

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  AM.norm = norm;

  // False once the extension has been reloaded or updated underneath this page; the
  // copy of the script left in the tab can no longer reach the extension and must stop.
  AM.alive = () => !AM.dead && !!chrome.runtime?.id;

  // Runs an extension call; if the extension has gone away mid-call, marks this copy
  // dead and returns the fallback instead of throwing.
  AM.safe = async (call, fallback = null) => {
    if (!AM.alive()) return fallback;
    try {
      return await call();
    } catch (e) {
      if (/context invalidated/i.test(String(e?.message))) AM.dead = true;
      return fallback;
    }
  };

  // Chrome slows page timers to a crawl in background tabs, which would stall a fill
  // the moment the person switches away. The service worker's timers are not slowed,
  // so a hidden tab waits by asking it instead.
  AM.sleep = (ms) =>
    (document.hidden || AM.workerTimers) && AM.alive()
      ? AM.safe(() => chrome.runtime.sendMessage({ type: 'sleep', ms }))
      : new Promise((r) => setTimeout(r, ms));

  const CONTROLS = 'input:not([type=hidden]):not([aria-hidden=true]),select,textarea,[role=combobox]';
  const SKIP_INPUT = new Set(['hidden', 'submit', 'button', 'image', 'reset', 'password', 'search', 'range', 'color']);
  const LABELISH = 'label,legend,[class*="label" i],[class*="question" i],[class*="title" i],[class*="heading" i]';

  function* walk(root) {
    for (const el of root.querySelectorAll('*')) {
      yield el;
      if (el.shadowRoot) yield* walk(el.shadowRoot);
    }
  }
  AM.walk = walk;

  function rendered(el) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  // Radios, checkboxes and file inputs are often visually hidden behind a styled
  // wrapper, so they count as shown when the nearest rendered ancestor is.
  function shown(el) {
    if (rendered(el)) return true;
    if (!el.matches('input[type=radio],input[type=checkbox],input[type=file]')) return false;
    for (let n = el.parentElement, i = 0; n && i < 4; n = n.parentElement, i++) if (rendered(n)) return true;
    return false;
  }

  // Set when the last label read carried a required marker (* or ✱).
  let sawStar = false;

  function textOf(el) {
    if (/[*✱]/.test(el.textContent)) sawStar = true;
    const c = el.cloneNode(true);
    c.querySelectorAll('input,select,textarea,button,script,style,svg,[role=listbox],[role=option]').forEach((n) => n.remove());
    return norm(c.textContent.replace(/[✱*]/g, ' '));
  }

  function byIds(el, ids) {
    const root = el.getRootNode();
    return norm(ids.split(/\s+/).map((i) => root.getElementById?.(i)?.textContent || '').join(' '));
  }

  function hasForeignControls(node, members) {
    for (const c of node.querySelectorAll(CONTROLS)) {
      if (members.includes(c) || members.some((m) => c.contains(m) || m.contains(c))) continue;
      if (shown(c)) return true;
    }
    return false;
  }

  // Walks up from the control until it finds label-like text that precedes it,
  // stopping as soon as the ancestor also holds another field.
  function climbLabel(start, members) {
    let node = start;
    for (let i = 0; i < 6 && node && node.nodeType === 1; i++) {
      if (!members.includes(node)) {
        const lb = node.getAttribute('aria-labelledby');
        const t = (lb && byIds(node, lb)) || norm(node.getAttribute('aria-label'));
        if (t) return t;
      }
      if (hasForeignControls(node, members)) break;
      for (const c of node.querySelectorAll(LABELISH)) {
        if (members.some((m) => c.contains(m))) continue;
        if (members.length > 1 && c.tagName === 'LABEL' && members.some((m) => m.id && m.id === c.htmlFor)) continue;
        if (!(c.compareDocumentPosition(members[0]) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
        const t = textOf(c);
        if (t && t.length <= 400) return t;
      }
      // Forms with no label markup at all (Gem): the question is simply the text
      // sitting just before the field inside the same wrapper.
      const branch = [...node.children].find((c) => members.some((m) => c === m || c.contains(m)));
      for (let sib = branch?.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (!rendered(sib)) continue;
        const t = textOf(sib);
        if (t && t.length <= 400) return t;
      }
      node = node.parentElement || node.getRootNode().host;
    }
    return '';
  }

  // Radios with no shared name: the smallest wrapper that holds two or more radios and nothing else.
  function radioBox(el) {
    for (let node = el.parentElement, i = 0; node && i < 5; node = node.parentElement, i++) {
      const inside = [...node.querySelectorAll(CONTROLS)];
      if (inside.some((c) => c.type !== 'radio')) return null;
      if (inside.length > 1) return node;
    }
    return null;
  }

  function ownLabel(el) {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = byIds(el, lb);
      if (t) return t;
    }
    if (el.id) {
      const l = el.getRootNode().querySelector?.(`label[for="${CSS.escape(el.id)}"]`);
      const t = l && textOf(l);
      if (t) return t;
    }
    const wrap = el.closest('label');
    if (wrap) {
      // A label wrapping the whole row (Lever) carries helper text too; its own label element is the question.
      const inner = wrap.querySelector('[class*="label" i]');
      const t = (inner && !inner.contains(el) && textOf(inner)) || textOf(wrap);
      if (t) return t;
    }
    return norm(el.getAttribute('aria-label'));
  }

  function optionLabel(el) {
    return ownLabel(el) || (el.tagName !== 'INPUT' && norm(el.textContent)) || norm(el.nextSibling?.textContent) || norm(el.parentElement?.textContent) || el.value;
  }

  function commonAncestor(members) {
    let node = members[0].parentElement;
    const last = members[members.length - 1];
    while (node && !node.contains(last)) node = node.parentElement;
    return node || members[0].parentElement;
  }

  function isCombo(el) {
    const tag = el.tagName;
    if (tag === 'SELECT') return false;
    if (tag === 'INPUT') {
      if (/^(file|checkbox|radio|hidden|submit|button)$/.test(el.type)) return false;
      return el.getAttribute('role') === 'combobox' || /list|both/.test(el.getAttribute('aria-autocomplete') || '') || !!el.closest('[role=combobox]') ||
        el.dataset.automationId === 'searchBox'; // Workday's search-and-pick boxes
    }
    if (el.getAttribute('role') === 'combobox' || (tag === 'BUTTON' && el.getAttribute('aria-haspopup') === 'listbox')) {
      return !el.querySelector('input:not([type=hidden])');
    }
    return false;
  }

  function isRequired(el, label) {
    const own = el.id && el.getRootNode().querySelector?.(`label[for="${CSS.escape(el.id)}"]`);
    return /[*✱]/.test(own?.textContent || '') || /\brequired\b/i.test(el.getAttribute('aria-label') || '') || el.required || el.getAttribute('aria-required') === 'true' || /\(required\)/i.test(label) || !!el.closest('label,li,div')?.querySelector('.required,[class*="required" i]');
  }

  function selectIsEmpty(el) {
    const o = el.selectedOptions[0];
    return !o || !o.value || (el.selectedIndex === 0 && /^(-+|select|choose|please)/i.test(norm(o.textContent)));
  }

  // Whether a tick box or radio is on, for native ones and for custom-built ones.
  AM.isOn = (m) => (m.tagName === 'INPUT' ? m.checked : ['aria-checked', 'aria-pressed'].some((a) => m.getAttribute(a) === 'true'));

  // True when the page's own framework holds something different from what a field
  // shows, i.e. the answer is visible but the form has not registered it. Asks the
  // helper in content/page.js; pages it cannot read count as fine.
  AM.unregistered = function (f) {
    if (!['text', 'textarea', 'number', 'date', 'select', 'radio', 'checkbox', 'checkboxes', 'dateparts'].includes(f.kind)) return false;
    return f.members.some((m) => {
      if (!/^(INPUT|TEXTAREA|SELECT)$/.test(m.tagName)) return false;
      m.dispatchEvent(new Event('applymate:state', { bubbles: true }));
      const said = m.getAttribute('data-applymate-state');
      m.removeAttribute('data-applymate-state');
      return said === 'false';
    });
  };

  AM.currentValue = function (f) {
    const el = f.el;
    switch (f.kind) {
      case 'select':
        return selectIsEmpty(el) ? '' : norm(el.selectedOptions[0].textContent);
      case 'radio':
      case 'checkboxes': {
        const on = f.members.map((m, i) => (AM.isOn(m) ? f.options[i] : null)).filter(Boolean);
        return f.kind === 'radio' ? on[0] || '' : on.join(' | ');
      }
      case 'buttons': {
        const on = f.members.findIndex((m) => m.getAttribute('aria-pressed') === 'true' || m.getAttribute('aria-checked') === 'true' || /active|selected/i.test(m.className));
        return on < 0 ? '' : f.options[on];
      }
      case 'checkbox':
        return AM.isOn(el) ? 'Yes' : '';
      case 'dateparts':
        return f.members.map((m) => m.value).filter(Boolean).join('/');
      case 'file':
        return el.files?.[0]?.name || '';
      case 'combobox': {
        if (el.tagName !== 'INPUT') {
          const t = norm(el.textContent);
          return /^(select|choose|please|--)/i.test(t) ? '' : t;
        }
        if (el.value) return el.value;
        // Pickers keep the chosen text in a sibling of the input, a few wrappers up.
        // Stop before a wrapper that also holds another field, or its value would be read.
        for (let box = el.parentElement, i = 0; box && i < 4; box = box.parentElement, i++) {
          if (box.querySelectorAll(`${CONTROLS},button[aria-haspopup]`).length > 1) break;
          const single = box.querySelector('[class*="singleValue" i],[class*="single-value" i],[class*="multiValue" i],[class*="multi-value" i],[data-automation-id="selectedItem"]');
          if (single) return norm(single.textContent);
        }
        return '';
      }
      default:
        return el.value || '';
    }
  };

  AM.scan = function () {
    const fields = [];
    const groups = new Map();
    const all = [...walk(document)];
    const headings = all.filter((e) => e.matches('h1,h2,h3,h4,h5,legend,[role=heading]') && rendered(e));
    let n = 0;

    const add = (kind, el, extra = {}) => {
      const f = { id: `am${++n}`, kind, el, members: [el], ...extra };
      fields.push(f);
      return f;
    };

    // Yes/No style questions built from plain buttons (Ashby); the hidden input
    // they keep in sync is not a field of its own.
    const buttonBoxes = all.filter((b) => b.matches('[class*="yesno" i],[class*="button-group" i],[class*="buttonGroup" i]'));

    for (const el of all) {
      const tag = el.tagName;
      if (buttonBoxes.some((b) => b.contains(el))) continue;
      if (!/^(INPUT|SELECT|TEXTAREA|BUTTON|DIV|SPAN)$/.test(tag)) continue;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true' || el.getAttribute('aria-hidden') === 'true') continue;
      if (el.closest('nav,footer,[role=search],[role=navigation]')) continue;

      if (isCombo(el)) {
        if (rendered(el) || rendered(el.parentElement)) add('combobox', el);
        continue;
      }
      if (tag === 'SELECT' || tag === 'TEXTAREA') {
        if (rendered(el)) add(tag === 'SELECT' ? 'select' : 'textarea', el);
        continue;
      }
      // Tick boxes and radios built from buttons or divs rather than real inputs.
      const role = el.getAttribute('role');
      if (tag !== 'INPUT' && (role === 'checkbox' || role === 'switch' || role === 'radio')) {
        if (!rendered(el) || el.querySelector('input:not([aria-hidden=true])')) continue;
        const key = (role === 'radio' && el.closest('[role=radiogroup],fieldset')) || el;
        let g = groups.get(key);
        if (!g) groups.set(key, (g = add(role === 'radio' ? 'radio' : 'checkboxes', el, { members: [], box: key === el ? null : key })));
        g.members.push(el);
        continue;
      }
      if (tag !== 'INPUT') continue;

      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (SKIP_INPUT.has(type) || !shown(el)) continue;

      // Workday splits a date into separate month / day / year boxes.
      const dateBox = el.closest('[data-automation-id="dateInputWrapper"]');
      if (dateBox) {
        let g = groups.get(dateBox);
        if (!g) groups.set(dateBox, (g = add('dateparts', el, { members: [], box: dateBox })));
        g.members.push(el);
        continue;
      }

      if (type === 'radio' || type === 'checkbox') {
        const box = el.closest('fieldset,[role=radiogroup],[role=group]');
        const pure = box && [...box.querySelectorAll(CONTROLS)].every((c) => c.type === type);
        const loose = type === 'radio' && !el.name && !box ? radioBox(el) : null;
        const key = type === 'radio' ? (el.name ? `r:${el.name}` : box || loose || el) : pure ? box : el.name ? `c:${el.name}` : el;
        let g = groups.get(key);
        if (!g) {
          g = add(type === 'radio' ? 'radio' : 'checkboxes', el, { members: [], box: pure ? box : loose });
          groups.set(key, g);
        }
        g.members.push(el);
      } else if (type === 'file') {
        add('file', el);
      } else if (type === 'number' || type === 'range') {
        add('number', el);
      } else if (type === 'date' || type === 'month' || /\b(mm|dd|yyyy)\b/i.test(el.placeholder || '')) {
        add('date', el);
      } else {
        add('text', el);
      }
    }

    for (const box of buttonBoxes) {
      const btns = [...box.querySelectorAll('button')].filter((b) => rendered(b) && norm(b.textContent).length < 30);
      if (btns.length >= 2) add('buttons', btns[0], { members: btns, box });
    }

    for (const f of fields) {
      const el = f.el;
      sawStar = false;
      if (f.kind === 'dateparts') {
        f.label = climbLabel(f.box.parentElement, f.members);
      } else if (f.kind === 'radio' || f.kind === 'checkboxes' || f.kind === 'buttons') {
        if (f.kind === 'checkboxes' && f.members.length === 1) {
          f.kind = 'checkbox';
          f.label = ownLabel(el) || climbLabel(el.parentElement, f.members);
        } else {
          f.options = f.members.map((m) => (f.kind === 'buttons' ? norm(m.textContent) : optionLabel(m)));
          f.label = f.kind === 'buttons'
            ? climbLabel(f.box.parentElement, [...f.members, ...f.box.querySelectorAll('input')])
            : climbLabel(f.box || commonAncestor(f.members), f.members);
          // Some widgets name each choice "<question> <choice>"; keep just the choice.
          f.options = f.options.map((o) => (f.label && o !== f.label && o.startsWith(f.label) ? norm(o.slice(f.label.length)) || o : o));
        }
      } else {
        f.label = ownLabel(el) || climbLabel(el.parentElement, f.members);
        if (f.kind === 'select') {
          f.optionEls = [...el.options].filter((o) => o.value && !o.disabled);
          f.options = f.optionEls.map((o) => norm(o.textContent));
        }
      }
      f.hint = norm([el.getAttribute('autocomplete'), el.name, el.id].filter(Boolean).join(' '));
      f.label = norm((f.label || el.placeholder || f.hint).replace(/[✱*]/g, ' '));
      f.placeholder = el.placeholder || '';
      f.required = sawStar || f.members.some((m) => isRequired(m, f.label));
      let section = '';
      for (const h of headings) {
        if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) section = textOf(h);
        else break;
      }
      f.section = section === f.label ? '' : section.slice(0, 120);
    }

    AM.fields = fields.filter((f) => f.label || f.kind === 'file');
    return AM.fields;
  };
})();
