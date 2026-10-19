// What the model is asked to write when tailoring a resume, shared by the extension
// and the command-line preview so both produce the same thing.
const str = { type: 'string' };
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

export const TAILOR_SYSTEM = `You tailor one person's resume to a specific job. You receive their profile (work history, skills, and the full text of their master resume) and the job description. A program lays out the final PDF: employers, titles, dates and education are copied from the profile unchanged, and you supply only the parts below.

- "summary": two or three sentences positioning this person for this job, using the job's own vocabulary where it honestly applies.
- "skills": the person's existing skills, most relevant to this job first. Drop ones that do not matter here. Never add a skill the profile or master resume does not show.
- "experience": for each entry in the profile's "experience" array (by zero-based "index"), up to five bullets, and never more than the source supports: a role the resume covers in two points gets two. Rewrite and reorder what the master resume already says so the work most relevant to this job leads. Keep every number, tool and outcome true to the source; do not introduce new ones.

A recruiter may ask about any line, so everything must be something this person can stand behind. Aim for one page.`;

export const TAILOR_SCHEMA = obj({
  summary: str,
  skills: { type: 'array', items: str },
  experience: { type: 'array', items: obj({ index: { type: 'integer' }, bullets: { type: 'array', items: str } }) },
});

export const jobBlock = (job) => `<job url="${job.url}" title="${job.title || ''}" company="${job.company || ''}">\n${job.jd}\n</job>`;

// The request for one tailored resume. Demographic answers, work authorization and
// job preferences are not needed to write a resume, so they are left out.
export function tailorRequest(profile, job) {
  const { eeo, work_authorization, preferences, screening, ...shared } = profile;
  return { system: TAILOR_SYSTEM, content: `<profile>\n${JSON.stringify(shared)}\n</profile>\n\n${jobBlock(job)}`, schema: TAILOR_SCHEMA };
}

// ---- Fixed-layout tailoring -----------------------------------------------------
// Used when the profile carries a "base resume": the person's own document, whose
// layout must not change. Only the summary, the bullets and the location are rewritten.

// The resume instructions: the user's third version (2026-10-18), condensed on
// 2026-10-19 to cut cost while keeping every rule (the full text is kept in
// tailored-resumes/resume-prompt-full.txt for reference).
export const BASE_TAILOR_SYSTEM = "You tailor one candidate's resume to one job so a recruiter's first screen selects them. The result must be truthful, role-specific, concise and ATS-readable.\n\nInputs: original_resume (the candidate's facts and metrics), confirmed_experience (extra facts the candidate verified; no numbers), job_description, layout_constraints (binding).\n\nPriorities, in order: factual accuracy; evidence for the job's most important requirements; business outcomes and existing metrics; clear ownership and decisions; the employer's terminology; readability; every layout constraint. A keyword without supporting evidence is not an improvement.\n\n1. Validate. If the job text is not a substantive description (an application form, consent or cookie page, navigation, generic branding) or its title/employer materially conflicts with the metadata, return status \"invalid_job_description\" with the reason. If the layout constraints cannot be met without distorting meaning or inventing facts, return \"constraint_error\" naming the conflict. Either way return an empty summary and experience.\n\n2. Analyze (internally). Rank the job's responsibilities, required and preferred qualifications, skills, domain needs, leadership expectations and success metrics as critical, high, medium or preferred, and identify the five strongest reasons to shortlist someone and the employer's own wording for them. Use the actual posting, not a generic idea of the title.\n\n3. Map evidence. For each important requirement, find the strongest support in original_resume or confirmed_experience: strong (direct), transferable (related, never presented as direct) or unsupported (left out). Check every confirmed_experience item.\n\n4. Rewrite.\n- Summary: the candidate's relevant identity and strongest evidence for this role, using metrics only where they strengthen the case; no generic adjectives, keyword lists or repetition of the bullets; no unsupported skill, title, seniority, industry or years.\n- Bullets: for each role keep its index, order, bullet count and bullet order. Emphasize the most relevant supported responsibilities, decisions and outcomes, ideally action + method or scope + outcome, starting with an accurate verb. Show personal ownership without overstating team work, connect technical work to user or business impact where supported, keep metrics and what they measure, name tools only when supported. Keep a strong bullet when rewriting would not help. Never trade a stronger relevant achievement for one more keyword.\n\n5. Facts. Candidate facts come only from original_resume and confirmed_experience. Never invent or inflate metrics, scale, counts, titles, dates, tools, ownership, leadership, customer or executive relationships, industry, regulatory or domain experience, certifications, results or causality. Every number must appear in the inputs. Do not turn participation into ownership, collaboration into sole responsibility, correlation into causation, or team results into individual ones. Prefer narrower wording when unsure.\n\n6. Layout. Return only the summary and the bullets; never change employers, titles, dates or other sections. Meet each piece's character range (spaces and punctuation count; the ** markers do not). At most one short **bold** phrase per bullet, never a whole bullet. Plain hyphens and the word \"to\", no arrows or en dashes. No explanatory text inside fields. Rendered line fit is measured by the calling system after you answer.\n\n7. Before returning, check: every claim traceable and numbers exact; nothing exaggerated; the summary signals fit immediately; strong evidence is prominent; indexes, order and bullet counts are intact; character ranges are met.\n\nOutput JSON only: {\"status\":\"ok\",\"reason\":\"\",\"summary\":\"...\",\"experience\":[{\"index\":0,\"bullets\":[\"...\"]}]}, every role in original order with its exact bullet count. On a validation or constraint failure, return that status, a specific reason, an empty summary and an empty experience array.\n\nMake the most relevant, credible evidence impossible for a recruiter to miss, without making the candidate appear to have every qualification.";

export const BASE_TAILOR_SCHEMA = obj({
  status: { type: 'string', enum: ['ok', 'invalid_job_description', 'constraint_error'] },
  reason: str,
  summary: str,
  experience: { type: 'array', items: obj({ index: { type: 'integer' }, bullets: { type: 'array', items: str } }) },
});

export const FIX_SCHEMA = obj({ pieces: { type: 'array', items: obj({ piece: str, text: str }) } });

const plain = (s) => s.replace(/\*\*/g, '');

// A piece of text meant to fill `lines` lines should fall in this character range.
// The lower end only has to tip the text onto its last line; asking for more would force padding.
export const charRange = (lines, perLine) => [Math.round((lines - 1) * perLine + 12), Math.round(lines * perLine - 4)];

// targets: the original's line counts from lineCounts(). fix: after a first answer,
// the pieces whose line count came out wrong, to be corrected in a second request.
// The parts of a posting that say nothing about the job itself (benefits, pay
// transparency, equal-opportunity and privacy statements) are cut before sending.
export function trimPosting(jd) {
  const text = String(jd || '');
  const tail = text.search(/\b(benefits (include|we offer)|what we offer|perks( and benefits)?:|our benefits|pay (range|transparency)|salary range|compensation (range|and benefits)|equal (employment )?opportunity|we are an equal|eeo statement|privacy (notice|policy)|reasonable accommodation)/i);
  return (tail > 1200 ? text.slice(0, tail) : text).slice(0, 4500).trim();
}

export function baseTailorRequest(profile, job, targets, fix) {
  const base = profile.base_resume;
  const summary = base.sections.find((x) => x.type === 'text');
  const roles = base.sections.find((x) => x.type === 'roles').roles;
  const want = (lines, perLine) => {
    const [lo, hi] = charRange(lines, perLine);
    return `${lines} line${lines === 1 ? '' : 's'}, ${lo}-${hi} characters`;
  };
  const resume = ['SUMMARY:', summary.text, ''];
  const limits = [`summary: exactly ${want(targets.summary, targets.summaryLineChars)}`];
  const confirmed = [];
  roles.forEach((r, i) => {
    resume.push(`ROLE ${i}: ${r.head} ${r.note || ''} | ${r.dates}`);
    r.bullets.forEach((b, n) => resume.push(`- bullet ${n + 1}: ${b}`));
    resume.push('');
    limits.push(`role ${i}: exactly ${r.bullets.length} bullets`, ...r.bullets.map((b, n) => `  role ${i}, bullet ${n + 1}: exactly ${want(targets.roles[i][n], targets.bulletLineChars)}`));
    const more = (profile.confirmed_experience || []).filter((c) => c.role === i);
    if (more.length) confirmed.push(`ROLE ${i}:`, ...more.map((c) => `- ${c.text}`));
  });
  const lines = [...resume];
  // Education and skills are sent for context only; the renderer keeps them unchanged.
  const readOnly = base.sections.filter((x) => x.type === 'bullets').map((x) => `${x.title} (not to be changed):\n${(x.lines || []).map((l) => `${l.bold}${l.rest} ${l.right}`).concat(x.bullets || []).map((l) => `- ${l.replace(/\*\*/g, '')}`).join('\n')}`).join('\n\n');
  const where = job.location ? ` location="${job.location}"` : '';
  // The resume and job are identical in the first request and any follow-up, so they
  // are marked for caching and a follow-up re-reads them at a fraction of the price.
  // Everything about the candidate is identical for every job, so it goes first and is
  // cached for an hour: the second and later resumes in that hour read it at a small
  // fraction of the price. Only the job description is new each time.
  const candidate = {
    type: 'text',
    text: [
      `<original_resume>\n${lines.join('\n')}\n${readOnly}</original_resume>`,
      `<confirmed_experience>\n${confirmed.join('\n') || '(none)'}\n</confirmed_experience>`,
      `<layout_constraints>\nCharacter ranges count spaces and punctuation, not the ** markers. A line holds about ${targets.bulletLineChars} characters in a bullet and ${targets.summaryLineChars} in the summary.\n${limits.join('\n')}\n</layout_constraints>`,
    ].join('\n\n'),
    cache_control: { type: 'ephemeral', ttl: '1h' },
  };
  const posting = { type: 'text', text: `<job_description title="${job.title || ''}" employer="${job.company || ''}"${where} source_url="${job.url}">\n${trimPosting(job.jd)}\n</job_description>`, cache_control: { type: 'ephemeral' } };
  const shared = [candidate, posting];
  if (!fix) return { system: BASE_TAILOR_SYSTEM, content: shared, schema: BASE_TAILOR_SCHEMA };
  // A follow-up is not a second resume: it shows the model its own first answer for
  // this same job and asks it to rewrite only the pieces that came out the wrong
  // length. Only those pieces come back, which keeps the follow-up cheap.
  const followUp = `<your_first_answer>\n${JSON.stringify(fix.answer)}\n</your_first_answer>\n\n<corrections>\nYour first answer above was laid out on the page and the pieces below came out the wrong length. Rewrite only these. Return each one with its "piece" label exactly as written here and its new "text"; everything else in your first answer is kept as it is.\n${fix.items.join('\n')}\n</corrections>`;
  return { system: BASE_TAILOR_SYSTEM, content: [...shared, { type: 'text', text: followUp }], schema: FIX_SCHEMA };
}
