// Runs in the page's own world (the other scripts cannot see the page's JavaScript).
// Its only job: when asked about a field, report whether the page's framework (React)
// holds the same value the field is showing. Nothing is changed and nothing leaves the page.
document.addEventListener(
  'applymate:state',
  (e) => {
    const el = e.target;
    let agrees = '';
    try {
      const key = Object.keys(el).find((k) => k.startsWith('__reactProps$'));
      const props = key && el[key];
      const box = el.type === 'checkbox' || el.type === 'radio';
      const held = props && (box ? props.checked : props.value);
      if (held !== undefined && held !== null) agrees = String(box ? held === el.checked : String(held) === el.value);
    } catch {}
    el.setAttribute('data-applymate-state', agrees);
  },
  true,
);
