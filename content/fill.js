// Writes a value into one field, whatever widget it is built from.
(() => {
  const AM = (globalThis.__AM ||= {});
  const sleep = AM.sleep;

  const fire = (el, type, Ctor = Event, init = {}) => el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, ...init }));
  const mouse = (el, ...types) => types.forEach((t) => fire(el, t, t.startsWith('pointer') ? PointerEvent : MouseEvent, { view: window, button: 0 }));
  const press = (el, key) => ['keydown', 'keyup'].forEach((t) => fire(el, t, KeyboardEvent, { key, code: key }));

  // React and friends track the value on the element instance; going through the
  // prototype setter and then firing `input` is what makes them notice the change.
  function setNative(el, value) {
    // Walk the element's own prototype chain for the built-in setter, so this also
    // works for custom elements and never applies an input's setter to something else.
    let setter;
    for (let p = Object.getPrototypeOf(el); p && !setter; p = Object.getPrototypeOf(p)) setter = Object.getOwnPropertyDescriptor(p, 'value')?.set;
    if (!setter || el.type === 'file') throw new Error('this field cannot be typed into');
    setter.call(el, value);
    fire(el, 'input', InputEvent, { data: String(value), inputType: 'insertText' });
  }

  // Focus and blur the way a person does. When the tab or frame is not the one in
  // front, the browser does not send these events itself, and forms that only accept
  // or validate an answer when you leave the field never notice it was filled.
  function moveFocus(el, method, direct, bubbling) {
    let fired = false;
    const note = () => (fired = true);
    el.addEventListener(direct, note, { once: true });
    el[method]({ preventScroll: true });
    el.removeEventListener(direct, note);
    if (fired) return;
    el.dispatchEvent(new FocusEvent(direct, { composed: true }));
    fire(el, bubbling, FocusEvent);
  }
  const enter = (el) => moveFocus(el, 'focus', 'focus', 'focusin');
  const leave = (el) => moveFocus(el, 'blur', 'blur', 'focusout');

  // Types a value: everything but the last character at once, then the last one as a
  // real keystroke, which is what makes stricter forms register the change.
  function typeInto(el, value) {
    value = String(value);
    enter(el);
    if (value.length > 1) setNative(el, value.slice(0, -1));
    const key = value.slice(-1);
    fire(el, 'keydown', KeyboardEvent, { key });
    setNative(el, value);
    fire(el, 'keyup', KeyboardEvent, { key });
    fire(el, 'change');
    leave(el);
  }

  // Clicks a tick box, radio or button with the full press-and-release a person makes.
  function clickLikeUser(el) {
    mouse(el, 'pointerdown', 'mousedown');
    enter(el);
    mouse(el, 'pointerup', 'mouseup');
    el.click();
    leave(el);
  }

  // Tries the control itself, then the real input or label inside or around it, since
  // custom widgets differ in which part actually listens (Workable: the inner input).
  async function turnOn(m) {
    const targets = [m, m.querySelector?.('input'), m.querySelector?.('label'), m.labels?.[0], m.closest('label')];
    for (const t of [...new Set(targets.filter(Boolean))]) {
      if (AM.isOn(m)) return;
      if (t === m) clickLikeUser(t);
      else t.click();
      await sleep(40);
    }
  }

  // Plain text boxes that pop up their own list of suggestions (Lever's location,
  // address finders) and discard typed text unless one is picked.
  const SUGGESTIONS = '[class*="dropdown" i] [id^="location-"],[class*="suggest" i] li,[class*="autocomplete" i] li,[class*="typeahead" i] li,.pac-item,[role=option]';
  // Kept narrow on purpose: waiting for a list that never comes costs over a second per field.
  const isTypeahead = (f) => /\blocation\b|where are you (currently )?(based|located)/i.test(f.label) || /location|autocomplete|typeahead|places/i.test(`${f.el.className} ${f.el.id} ${f.el.name}`);

  async function typeWithSuggestions(f, want) {
    const el = f.el;
    const shown = () => {
      let found = [];
      for (let box = el.parentElement, i = 0; box && i < 3 && !found.length; box = box.parentElement, i++) found = [...box.querySelectorAll(SUGGESTIONS)];
      if (!found.length) found = [...document.querySelectorAll('.pac-container .pac-item')];
      return found.filter((o) => o.getBoundingClientRect().height > 0);
    };
    enter(el);
    const city = String(want).split(',')[0];
    setNative(el, city.slice(0, -1));
    fire(el, 'keydown', KeyboardEvent, { key: city.slice(-1) });
    setNative(el, city);
    fire(el, 'keyup', KeyboardEvent, { key: city.slice(-1) });
    let opts = [];
    for (const end = Date.now() + 1300; Date.now() < end && !opts.length; ) {
      await sleep(100);
      opts = shown();
    }
    if (!opts.length) {
      // No list appeared, so this is an ordinary text box after all.
      typeInto(el, want);
      return true;
    }
    const texts = opts.map((o) => AM.norm(o.textContent));
    let idx = AM.pick(texts, want);
    if (idx < 0) idx = Math.max(0, AM.best(texts, want).idx);
    mouse(opts[idx], 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click');
    await sleep(80);
    fire(el, 'change');
    leave(el);
    return true;
  }

  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  function parseDate(s) {
    s = String(s).trim();
    let m = s.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/);
    if (m) return { y: +m[1], m: +m[2], d: +(m[3] || 1) };
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return { y: +m[3], m: +m[1], d: +m[2] };
    m = s.match(/^(\d{1,2})\/(\d{4})$/);
    if (m) return { y: +m[2], m: +m[1], d: 1 };
    m = s.toLowerCase().match(/([a-z]{3})[a-z]*\.?\s+(?:(\d{1,2}),?\s+)?(\d{4})/);
    if (m && MONTHS.includes(m[1])) return { y: +m[3], m: MONTHS.indexOf(m[1]) + 1, d: +(m[2] || 1) };
    return null;
  }

  function formatDate(el, value) {
    const dt = parseDate(value);
    if (!dt) return value;
    const p = (n) => String(n).padStart(2, '0');
    if (el.type === 'date') return `${dt.y}-${p(dt.m)}-${p(dt.d)}`;
    if (el.type === 'month') return `${dt.y}-${p(dt.m)}`;
    const ph = (el.placeholder || 'MM/DD/YYYY').toUpperCase();
    return ph.replace('YYYY', dt.y).replace('MM', p(dt.m)).replace('DD', p(dt.d));
  }

  function visibleOptions(el) {
    const root = el.getRootNode();
    const id = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
    const box = id && root.getElementById?.(id);
    let opts = box ? [...box.querySelectorAll('[role=option]')] : [];
    if (!opts.length) {
      const all = [...AM.walk(document)];
      opts = all.filter((o) => o.getAttribute('role') === 'option');
      // Workday's pickers mark their choices with their own attribute instead.
      if (!opts.length) opts = all.filter((o) => /^(promptOption|promptLeafNode|menuItem)$/.test(o.dataset?.automationId || ''));
    }
    return opts.filter((o) => o.getBoundingClientRect().height > 0 && o.getAttribute('aria-disabled') !== 'true');
  }

  async function waitOptions(el, ms) {
    const end = Date.now() + ms;
    let last = -1;
    for (;;) {
      const opts = visibleOptions(el);
      if (opts.length && opts.length === last) return opts;
      last = opts.length;
      if (Date.now() > end) return opts;
      await sleep(50);
    }
  }

  function openCombo(el) {
    el.scrollIntoView({ block: 'center' });
    mouse(el, 'pointerdown', 'mousedown');
    el.focus();
    mouse(el, 'pointerup', 'mouseup', 'click');
  }

  function closeCombo(el) {
    press(el, 'Escape');
    el.blur();
  }

  // Reads a dropdown's choices up front so they can go to the AI in the page's one request.
  AM.harvest = async function (f) {
    openCombo(f.el);
    const texts = (await waitOptions(f.el, 500)).map((o) => AM.norm(o.textContent)).filter(Boolean);
    closeCombo(f.el);
    await sleep(30);
    if (texts.length && texts.length <= 80) f.options = texts;
  };

  const optionText = (o) => AM.norm(o.getAttribute('data-automation-label') || o.textContent);

  // What to type into a search-as-you-type dropdown, most specific first: each part of
  // the value ("Foster School of Business, University of Washington" is two), then
  // shorter prefixes for lists that only match from the start of a word.
  function queries(want) {
    // Two-letter parts (a state code such as "NY") are useless as a search and match unrelated places.
    const parts = String(want).split(/\s*[,(|–]\s*|\s+-\s+/).map((p) => p.replace(/\)$/, '').trim()).filter((p) => p.length > 2);
    const out = [...parts];
    for (const p of parts) {
      const words = p.split(/\s+/);
      if (words.length > 2) out.push(words.slice(0, 2).join(' '));
      if (words[0].length > 5) out.push(words[0].slice(0, 4));
    }
    return [...new Set(out.map((q) => q.slice(0, 40)))].slice(0, 4);
  }

  function typeQuery(el, q) {
    setNative(el, q);
    press(el, q.slice(-1) || 'Backspace');
  }

  // Dropdowns and search-and-pick boxes. A strong text match is taken directly; when
  // the list only has near misses, the AI (if available) picks from what is on screen,
  // and failing that the closest option by shared words is used.
  async function fillCombo(f, values, choose) {
    const el = f.el;
    const want = values[0];
    openCombo(el);
    const typeable = el.tagName === 'INPUT' && !el.readOnly;
    let opts = await waitOptions(el, 600);
    let idx = AM.pick(opts.map(optionText), want);
    let searched = false;

    if (idx < 0 && typeable) {
      let shown = opts;
      for (const q of queries(want)) {
        typeQuery(el, q);
        await sleep(120);
        // Workday's search boxes only look things up on Enter, so send it straight away there.
        const needsEnter = el.dataset.automationId === 'searchBox';
        if (needsEnter) press(el, 'Enter');
        let found = await waitOptions(el, needsEnter ? 1500 : 700);
        if (!found.length && !needsEnter) {
          press(el, 'Enter');
          found = await waitOptions(el, 900);
        }
        if (!found.length) continue;
        searched = true;
        shown = found;
        idx = AM.pick(found.map(optionText), want);
        if (idx >= 0) break;
      }
      opts = shown;
    }

    if (idx < 0 && opts.length) {
      const texts = opts.map(optionText);
      const close = AM.best(texts, want);
      if (close.score >= 0.6) idx = close.idx;
      else if (choose && texts.length <= 60) idx = texts.indexOf(await choose(f, texts, want));
      // The list on screen may have been redrawn while waiting; re-read it before clicking.
      if (idx >= 0) {
        const now = visibleOptions(el);
        idx = now.findIndex((o) => optionText(o) === texts[idx]);
        opts = now;
      } else if (close.score >= 0.34 || (searched && texts.length === 1)) idx = close.idx;
    }

    if (idx < 0) {
      if (typeable) setNative(el, '');
      closeCombo(el);
      return false;
    }
    const opt = opts[idx];
    opt.scrollIntoView({ block: 'nearest' });
    mouse(opt, 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click');
    await sleep(50);
    if (visibleOptions(el).length) press(el, 'Escape');
    leave(el);
    return true;
  }

  function fileFromStored(resume) {
    const bin = atob(resume.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], resume.name, { type: resume.type || 'application/pdf' });
  }

  // values: array of strings (one entry unless the field takes several).
  // Returns true when something was set.
  AM.fill = async function (f, values, { resume, choose } = {}) {
    const el = f.el;
    const want = values[0];
    switch (f.kind) {
      case 'text':
        if (isTypeahead(f)) return typeWithSuggestions(f, want);
        typeInto(el, want);
        return true;
      case 'textarea':
        typeInto(el, want);
        return true;
      case 'number': {
        // A number box silently drops anything that is not a number.
        const n = String(want).replace(/,/g, '').match(/-?\d+(\.\d+)?/)?.[0];
        if (n === undefined) throw new Error('this box only accepts a number');
        typeInto(el, n);
        return true;
      }
      case 'date':
        typeInto(el, formatDate(el, want));
        return true;
      case 'dateparts': {
        const dt = parseDate(want);
        if (!dt) return false;
        for (const m of f.members) {
          const part = /month/i.test(m.dataset.automationId) ? dt.m : /day/i.test(m.dataset.automationId) ? dt.d : dt.y;
          typeInto(m, String(part).padStart(/year/i.test(m.dataset.automationId) ? 4 : 2, '0'));
        }
        return true;
      }
      case 'select': {
        const i = AM.pick(f.options, want);
        if (i < 0) return false;
        enter(el);
        setNative(el, f.optionEls[i].value);
        fire(el, 'change');
        leave(el);
        return true;
      }
      case 'radio':
      case 'buttons': {
        const i = AM.pick(f.options, want);
        if (i < 0) return false;
        await turnOn(f.members[i]);
        return true;
      }
      case 'checkboxes': {
        let any = false;
        for (const v of values) {
          const i = AM.pick(f.options, v);
          if (i < 0) continue;
          await turnOn(f.members[i]);
          any = true;
        }
        return any;
      }
      case 'checkbox':
        if (/^(yes|true)$/i.test(want)) await turnOn(el);
        return true;
      case 'file': {
        if (!resume?.base64) return false;
        // A resume left over from an earlier application (Workday keeps it) is removed first.
        for (let box = el.parentElement, i = 0; box && i < 6; box = box.parentElement, i++) {
          const old = [...box.querySelectorAll('[data-automation-id="delete-file"]')];
          if (!old.length) continue;
          for (const b of old.slice(0, 3)) b.click();
          await sleep(400);
          break;
        }
        const dt = new DataTransfer();
        dt.items.add(fileFromStored(resume));
        el.files = dt.files;
        fire(el, 'input');
        fire(el, 'change');
        return true;
      }
      case 'combobox':
        return fillCombo(f, values, choose);
    }
    return false;
  };
})();
