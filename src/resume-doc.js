// Re-renders a person's own resume with its original layout: same page, margins,
// font size, spacing and rules. Only the text of the summary, the bullets and the
// two location spots is ever swapped. The measurements live in the "base resume"
// (profile.base_resume), taken from the original document, so nothing here decides
// how the page looks.
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

// Characters the embedded font does not have are replaced with plain equivalents.
const clean = (s) => String(s ?? '').replace(/→/g, 'to').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^\x20-\x7E\xA0-\xFF–—•…]/g, '');

// "plain **bold** plain" -> [{ text, bold }]
function runs(s) {
  return clean(s).split(/(\*\*[^*]+\*\*)/).filter(Boolean).map((part) => (part.startsWith('**') ? { text: part.slice(2, -2), bold: true } : { text: part, bold: false }));
}

// The base resume with one job's tailored text and location dropped in.
export function applyTailoring(base, tailored) {
  const doc = structuredClone(base);
  const loc = (tailored.location || '').trim();
  if (loc) doc.contact[0] = loc;
  for (const section of doc.sections) {
    if (section.type === 'text' && tailored.summary) section.text = tailored.summary;
    if (section.type !== 'roles') continue;
    section.roles.forEach((role, i) => {
      const t = tailored.experience?.find((e) => e.index === i);
      if (t?.bullets?.length) role.bullets = t.bullets;
      // The location on the current role follows the job's, as the header does.
      if (i === 0 && loc) role.location = loc;
    });
  }
  return doc;
}

// Puts every page after the first from the person's original file behind the new
// first page, untouched: copied as they are, not re-created.
// A page that draws nothing visible: Google Docs often adds one at the end for a
// stray empty line (two space characters and nothing else).
function isEmptyPage(doc, page) {
  const c = page.node.Contents();
  if (!c) return true;
  const streams = c instanceof PDFArray ? c.asArray().map((r) => doc.context.lookup(r)) : [c];
  const ops = streams.map((st) => (st instanceof PDFRawStream ? new TextDecoder('latin1').decode(decodePDFRawStream(st).decode()) : '')).join('\n');
  return ops.length < 2000 && (ops.match(/\b(Tj|TJ)\b/g) || []).length <= 4 && !/\bDo\b/.test(ops);
}

export async function keepLaterPages(firstPageBytes, originalBytes) {
  const out = await PDFDocument.load(firstPageBytes);
  const original = await PDFDocument.load(originalBytes);
  const rest = original.getPageIndices().slice(1).filter((i) => !isEmptyPage(original, original.getPage(i)));
  for (const page of await out.copyPages(original, rest)) out.addPage(page);
  return out.save();
}

// How many lines the summary and each bullet occupy in this layout, measured with the
// real font, plus how many characters a full line holds. The page only looks like the
// original when these line counts match the original's.
export async function lineCounts(doc, fonts) {
  const L = doc.layout;
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const regular = await pdf.embedFont(fonts.regular);
  const bold = await pdf.embedFont(fonts.bold);
  const right = L.page[0] - L.margin;
  const count = (text, x) => {
    let lines = 1;
    let w = 0;
    let full = [];
    let chars = 0;
    for (const r of runs(text)) {
      for (const word of r.text.split(/(\s+)/).filter(Boolean)) {
        const ww = (r.bold ? bold : regular).widthOfTextAtSize(word, L.size);
        if (!/^\s+$/.test(word) && w + ww > right - x && w > 0) {
          full.push(chars);
          lines++;
          w = 0;
          chars = 0;
        }
        if (/^\s+$/.test(word) && w === 0) continue;
        w += ww;
        chars += word.length;
      }
    }
    return { lines, full };
  };
  const summary = count(doc.sections.find((s) => s.type === 'text').text, L.margin);
  const roles = doc.sections.find((s) => s.type === 'roles').roles.map((r) => r.bullets.map((b) => count(b, L.text_x)));
  const avg = (xs) => Math.round(xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length));
  return {
    summary: summary.lines,
    roles: roles.map((bs) => bs.map((b) => b.lines)),
    summaryLineChars: avg(summary.full) || 118,
    bulletLineChars: avg(roles.flat().flatMap((b) => b.full)) || 112,
  };
}

// Returns { bytes, bottom } where bottom is the lowest baseline used; it must stay
// above layout.bottom for the resume to fit its single page.
export async function renderDoc(doc, fonts) {
  const L = doc.layout;
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const regular = await pdf.embedFont(fonts.regular, { subset: true });
  const bold = await pdf.embedFont(fonts.bold, { subset: true });
  const page = pdf.addPage(L.page);
  const ink = rgb(...L.ink);
  const size = L.size;
  const right = L.page[0] - L.margin;
  const width = (rs) => rs.reduce((w, r) => w + (r.bold ? bold : regular).widthOfTextAtSize(r.text, size), 0);

  function draw(rs, x, y) {
    for (const r of rs) {
      const font = r.bold ? bold : regular;
      page.drawText(r.text, { x, y, font, size, color: ink });
      x += font.widthOfTextAtSize(r.text, size);
    }
  }

  // Greedy word wrap that keeps bold runs intact across lines.
  function wrap(rs, max) {
    const words = rs.flatMap((r) => r.text.split(/(\s+)/).filter(Boolean).map((text) => ({ text, bold: r.bold })));
    const lines = [[]];
    let w = 0;
    for (const word of words) {
      const ww = (word.bold ? bold : regular).widthOfTextAtSize(word.text, size);
      const space = /^\s+$/.test(word.text);
      if (!space && w + ww > max && lines.at(-1).length) {
        while (lines.at(-1).length && /^\s+$/.test(lines.at(-1).at(-1).text)) lines.at(-1).pop();
        lines.push([]);
        w = 0;
      }
      if (space && !lines.at(-1).length) continue;
      lines.at(-1).push(word);
      w += ww;
    }
    return lines;
  }

  let y = L.name_y;
  const center = (rs, at) => draw(rs, (L.page[0] - width(rs)) / 2, at);
  center([{ text: clean(doc.name), bold: true }], y);
  y -= L.contact_gap;
  center(runs(doc.contact.join(' • ')), y);
  let lead = L.bullet_line; // line height of whatever was drawn last

  const paragraph = (text, x, firstY, line) => {
    let at = firstY;
    for (const ln of wrap(runs(text), right - x)) {
      draw(ln, x, at);
      at -= line;
    }
    return at + line; // baseline of the last line
  };

  for (const section of doc.sections) {
    y -= lead + L.heading_before;
    draw([{ text: clean(section.title), bold: true }], L.margin, y);
    page.drawLine({ start: { x: L.margin, y: y - L.rule_drop }, end: { x: right, y: y - L.rule_drop }, thickness: L.rule_width, color: rgb(...L.rule) });

    if (section.type === 'text') {
      y = paragraph(section.text, L.margin, y - L.heading_after, L.text_line);
      lead = L.text_line;
    } else if (section.type === 'roles') {
      section.roles.forEach((role, i) => {
        y -= i ? role.before : L.role_after_heading;
        const head = [{ text: clean(role.head), bold: true }, ...(role.note ? [{ text: ` ${clean(role.note)}`, bold: false }] : [])];
        draw(head, L.margin, y);
        const when = [{ text: clean(`${role.location} | ${role.dates}`), bold: false }];
        draw(when, right - width(when), y);
        if (role.sub) {
          y -= L.role_to_bullet;
          draw(runs(role.sub), L.margin, y);
        }
        role.bullets.forEach((b, n) => {
          y -= n ? role.bullet_gap : role.sub ? role.sub_to_bullet : role.head_to_bullet;
          draw([{ text: '•', bold: false }], L.bullet_x, y);
          y = paragraph(b, L.text_x, y, L.bullet_line);
        });
      });
      lead = L.bullet_line;
    } else if (section.type === 'lines') {
      section.lines.forEach((ln, i) => {
        y -= i ? L.line_gap : L.heading_after;
        draw([{ text: clean(ln.bold), bold: true }, { text: clean(ln.rest), bold: false }], L.margin, y);
        const r = [{ text: clean(ln.right), bold: false }];
        draw(r, right - width(r), y);
      });
      lead = L.bullet_line;
    } else if (section.type === 'bullets') {
      section.bullets.forEach((b, i) => {
        y -= i ? L.bullet_line : L.heading_after;
        draw([{ text: '•', bold: false }], L.bullet_x, y);
        y = paragraph(b, L.text_x, y, L.bullet_line);
      });
      lead = L.bullet_line;
    }
  }
  return { bytes: await pdf.save(), bottom: y, fits: y >= L.bottom };
}
