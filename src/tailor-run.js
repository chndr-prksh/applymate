// Produces one tailored resume PDF. With a fixed layout the text must take exactly the
// same number of lines as the original, so each answer is laid out and measured, and
// any piece that came out a line long or short is sent back once or twice to be fixed.
import { renderResume } from './pdf.js';
import { applyTailoring, keepLaterPages, lineCounts, renderDoc } from './resume-doc.js';
import { baseTailorRequest, charRange, tailorRequest } from './tailor.js';

const MAX_REQUESTS = 3;

// ask(request) -> parsed JSON answer. fonts: { regular, bold } bytes for the fixed layout.
// original: the person's own resume PDF; when given, its pages after the first are kept as they are.
// location: the "City, ST" this application uses (empty keeps the resume's own).
export async function tailorPdf({ profile, job, ask, fonts, original, location = '' }) {
  if (!profile.base_resume) {
    const request = tailorRequest(profile, job);
    const tailored = await ask(request);
    return { tailored, bytes: await renderResume(profile, tailored), fits: true, exact: true, requests: [request] };
  }
  const base = profile.base_resume;
  const targets = await lineCounts(base, fonts);
  const requests = [];
  let best = null;
  let fix = null;

  for (let n = 0; n < MAX_REQUESTS; n++) {
    const request = baseTailorRequest(profile, job, targets, fix);
    requests.push(request);
    // The location on the resume is decided from the posting, not by the model, so it
    // always matches what the form's location fields are filled with.
    const answer = await ask(request);
    // The model judged the job text not to be a real job description: stop rather than
    // produce a generic rewrite. The caller attaches the original and asks for the posting.
    if (!fix && answer.status === 'invalid_job_description') throw new Error(`job description rejected: ${answer.reason || 'not a job description'}`);
    if (!fix && answer.status === 'constraint_error') throw new Error(`the rewrite could not fit the layout: ${answer.reason || 'constraint error'}`);
    // A follow-up returns only the rewritten pieces; put them into the first answer.
    const merged = fix ? structuredClone(fix.answer) : answer;
    for (const p of fix ? answer.pieces || [] : []) {
      const m = p.piece.match(/role (\d+), bullet (\d+)/);
      if (/^summary/.test(p.piece)) merged.summary = p.text;
      else if (m) {
        const role = merged.experience.find((e) => e.index === +m[1]);
        if (role?.bullets[+m[2] - 1] !== undefined) role.bullets[+m[2] - 1] = p.text;
      }
    }
    const tailored = { ...merged, location };
    const doc = applyTailoring(base, tailored);
    const got = await lineCounts(doc, fonts);

    const items = [];
    let off = 0;
    const check = (label, have, want, perLine) => {
      if (have === want) return;
      off += Math.abs(have - want);
      const [lo, hi] = charRange(want, perLine);
      items.push(`- ${label}: came out at ${have} line${have === 1 ? '' : 's'}, must be ${want}. Rewrite it to ${lo}-${hi} characters.`);
    };
    check('summary', got.summary, targets.summary, targets.summaryLineChars);
    targets.roles.forEach((role, i) => role.forEach((want, b) => check(`role ${i}, bullet ${b + 1}`, got.roles[i]?.[b] ?? 0, want, targets.bulletLineChars)));

    const rendered = await renderDoc(doc, fonts);
    const attempt = { tailored, ...rendered, off, exact: off === 0 };
    // Keep the closest attempt that still fits on the page.
    if (rendered.fits && (!best || off < best.off)) best = attempt;
    if (!best) best = attempt;
    if (off === 0) break;
    fix = { answer: { summary: tailored.summary, experience: tailored.experience }, items };
  }

  if (original) best.bytes = await keepLaterPages(best.bytes, original);
  return { ...best, requests };
}
