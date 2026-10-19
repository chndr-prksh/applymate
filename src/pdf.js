// Lays out the tailored resume as a one-column PDF. Employers, titles, dates and
// education come straight from the profile; only the summary, skill order and
// bullets come from the model.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const PAGE = [612, 792];
const MARGIN = 50;
const WIDTH = PAGE[0] - MARGIN * 2;
const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.35, 0.37, 0.4);

// The built-in fonts only cover Windows-1252.
const clean = (s) =>
  String(s ?? '')
    .replace(/[‘’′]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/→/g, '->')
    .replace(/[^\x20-\x7E\xA0-\xFF–—•…]/g, '')
    .trim();

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function when(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{1,2})/);
  return m ? `${MONTHS[+m[2] - 1]} ${m[1]}` : clean(s);
}
const range = (a, b, current) => [when(a), current || !b ? 'Present' : when(b)].filter(Boolean).join(' – ');

// A resume should be one page. The layout is tried at full size and then tightened in
// steps until it fits; if even the tightest does not, that version is used as is.
export async function renderResume(profile, tailored) {
  let doc;
  for (const k of [1, 0.95, 0.9, 0.85, 0.8]) {
    doc = await layout(profile, tailored, k);
    if (doc.getPageCount() === 1) break;
  }
  return doc.save();
}

async function layout(profile, tailored, k) {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage(PAGE);
  let y = PAGE[1] - MARGIN;

  const room = (h) => {
    if (y - h < MARGIN) {
      page = doc.addPage(PAGE);
      y = PAGE[1] - MARGIN;
    }
  };

  function wrap(text, font, size, width) {
    const lines = [];
    let line = '';
    for (const word of clean(text).split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (line && font.widthOfTextAtSize(next, size) > width) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    if (line) lines.push(line);
    return lines;
  }

  function text(str, { font = regular, size = 10, color = INK, x = MARGIN, width = WIDTH, gap = 3.5, align } = {}) {
    size *= k;
    gap *= k;
    for (const line of wrap(str, font, size, width)) {
      room(size + gap);
      y -= size;
      const dx = align === 'center' ? (width - font.widthOfTextAtSize(line, size)) / 2 : 0;
      page.drawText(line, { x: x + dx, y, font, size, color });
      y -= gap;
    }
  }

  function heading(title) {
    y -= 8 * k;
    room(30);
    text(title.toUpperCase(), { font: bold, size: 9.5, color: MUTED, gap: 3 });
    page.drawLine({ start: { x: MARGIN, y }, end: { x: MARGIN + WIDTH, y }, thickness: 0.6, color: MUTED });
    y -= 6 * k;
  }

  // A bold line with an optional lighter continuation, and a date pushed to the right edge.
  function split(left, right, rest = '') {
    room(15);
    y -= 10.5 * k;
    const l = clean(left);
    const r = clean(right);
    page.drawText(l, { x: MARGIN, y, font: bold, size: 10.5 * k, color: INK });
    if (rest) page.drawText(clean(rest), { x: MARGIN + bold.widthOfTextAtSize(l, 10.5 * k) + 6, y, font: regular, size: 9.5 * k, color: MUTED });
    page.drawText(r, { x: MARGIN + WIDTH - regular.widthOfTextAtSize(r, 9.5 * k), y, font: regular, size: 9.5 * k, color: MUTED });
    y -= 3.5 * k;
  }

  const DOT = '\u2022';
  const a = profile.address || {};
  const links = Object.values(profile.links || {}).filter(Boolean).map((l) => l.replace(/^https?:\/\/(www\.)?/, ''));
  text([profile.first_name, profile.last_name].filter(Boolean).join(' '), { font: bold, size: 20, align: 'center', gap: 6 });
  text([[a.city, a.state].filter(Boolean).join(', '), profile.phone, profile.email, ...links].filter(Boolean).join(`  ${DOT}  `), { size: 9.5, color: MUTED, align: 'center' });

  if (tailored.summary) {
    heading('Summary');
    text(tailored.summary);
  }

  const jobs = (profile.experience || []).map((e, i) => ({ ...e, bullets: tailored.experience?.find((t) => t.index === i)?.bullets || [e.description] }));
  if (jobs.length) heading('Experience');
  for (const job of jobs) {
    split([job.title, job.company].filter(Boolean).join(', '), range(job.start, job.end, job.current), job.location ? `${DOT}  ${job.location}` : '');
    for (const b of job.bullets.filter(Boolean)) {
      room(14);
      page.drawText(DOT, { x: MARGIN + 4, y: y - 10 * k, font: regular, size: 10 * k, color: INK });
      text(b, { x: MARGIN + 16, width: WIDTH - 16 });
    }
    y -= 5 * k;
  }

  if (profile.education?.length) heading('Education');
  for (const e of profile.education || []) {
    split(e.school, range(e.start, e.end), `${DOT}  ${[e.degree, e.field].filter(Boolean).join(', ')}${e.gpa ? `, GPA ${e.gpa}` : ''}`);
  }

  if (tailored.skills?.length) {
    heading('Skills');
    text(tailored.skills.join(', '));
  }

  return doc;
}
