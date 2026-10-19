// Instant, no-AI answers: maps common application questions onto the saved profile
// and picks the matching option in a list.
(() => {
  const AM = (globalThis.__AM ||= {});

  const canon = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9+#]+/g, ' ').trim();
  AM.canon = canon;
  AM.key = (f) => canon(f.label).slice(0, 160);
  // Fields that follow the application's location rather than an answer saved from another job.
  // Only short field names count ("City", "ZIP code", "Current location"), not questions that merely mention a country.
  AM.isLocation = (f) => {
    const l = canon(f.label);
    return l.split(' ').length <= 5 && /^(current |your |home |mailing |street )?(location|city|town|state|province|region|zip|postal|country|address)\b/.test(l) && !/e ?mail|web|code$/.test(l.replace(/(zip|postal) code$/, ''));
  };
  // A saved answer as a list of values (older entries were stored as the bare value).
  AM.saved = (entry) => {
    const v = [].concat(entry?.a ?? entry ?? []).filter(Boolean);
    return v.length ? v : null;
  };

  const yn = (b) => (b === true ? 'Yes' : b === false ? 'No' : b || '');
  const US = /united states|\bu\.?s\.?a?\b|america/i;
  const OTHER_COUNTRY = /\b(uk|united kingdom|canada|germany|india|ireland|australia|france|netherlands|singapore|japan|eu|europe|spain|brazil|mexico|poland|israel)\b/i;

  const SENSITIVE = [
    [/hispanic|latin[oax]/, 'hispanic'],
    [/race|ethnic/, 'race'],
    [/veteran|military status/, 'veteran'],
    [/disabilit/, 'disability'],
    [/sexual orientation|lgbtq/, 'sexual_orientation'],
    [/transgender/, 'transgender'],
    [/gender|\bsex\b/, 'gender'],
    [/pronoun/, 'pronouns'],
    [/\bage\b|how old/, 'age'],
    [/do you identify|identify (as|with)|communit(y|ies) (do )?you belong|religio|marital status/, 'identity'],
  ];

  // Visa questions are phrased too many ways for a pattern to answer safely. With AI
  // available they go to the model; these two patterns are only the offline fallback.
  const WORK_AUTH = [
    /sponsor|visa|immigration/,
    /authori[sz]ed to work|eligible to work|right to work|work authori[sz]ation|work permit|legally (permitted|able|entitled|allowed) to work/,
  ];
  AM.isWorkAuth = (f) => /citizen|permanent resident|green card/.test(canon(f.label)) || WORK_AUTH.some((re) => re.test(canon(f.label)));

  // [pattern on the cleaned label, value from profile]. First match wins.
  const RULES = [
    [/linkedin/, (p) => p.links?.linkedin],
    [/github/, (p) => p.links?.github],
    [/twitter|\bx profile/, (p) => p.links?.twitter],
    [/portfolio|personal (web)?site|website|^url$/, (p) => p.links?.portfolio],
    [/other (link|url|website)/, (p) => p.links?.other || p.links?.portfolio],
    [/preferred.*name|nickname/, (p) => p.preferred_name || p.first_name],
    [/first name|given name|^first$/, (p) => p.first_name],
    [/middle name/, (p) => p.middle_name],
    [/last name|family name|surname|^last$/, (p) => p.last_name],
    [/^(full |legal |your )?name$|full name|legal name/, (p) => [p.first_name, p.last_name].filter(Boolean).join(' ')],
    [/\be ?mail/, (p) => p.email],
    [/country code|phone country|dial code/, (p) => p.phone_country],
    [/phone (device )?type/, (p) => p.phone_type || 'Mobile'],
    [/phone ext/, () => undefined],
    [/phone|mobile|telephone|contact number/, (p) => p.phone],
    [/address line 2|apartment|\bapt\b|suite/, (p) => p.address?.line2],
    [/street|address line 1|^address$|mailing address|home address/, (p) => p.address?.line1],
    [/^(current )?location|location city|where are you (currently )?(located|based)|city and state/, (p) => [p.address?.city, p.address?.state || p.address?.country].filter(Boolean).join(', ')],
    [/^city$|city of residence|^town/, (p) => p.address?.city],
    [/^state$|state province|^province|^region$/, (p) => p.address?.state],
    [/zip|postal/, (p) => p.address?.postal_code],
    [/^country$|country of residence|country region|which country/, (p) => p.address?.country],
    [/current (company|employer|organization)|^company( name)?$|^employer$|^org(anization)?$/, (p) => p.current_company],
    [/current (job )?title|^(job )?title$|current (role|position)/, (p) => p.current_title],
    [/^(total )?years of (professional |work |relevant )?experience$/, (p) => p.years_experience],
    [/^(current|present) (salary|compensation|ctc)/, (p) => p.preferences?.current_salary],
    [/salary|compensation expectation|desired (pay|compensation)|expected (pay|ctc)/, (p) => p.preferences?.salary_expectation],
    [/notice period/, (p) => p.preferences?.notice_period],
    [/(earliest|available|when can you|able to) start|^start date$|date available/, (p) => p.preferences?.earliest_start_date],
    [/how (did )?you (hear|heard|find|found|learn)|where did you (hear|find)|^source$/, (p) => p.how_did_you_hear],
    // One question can mention both ("Are you authorised to work here, or will you need
    // sponsorship?"); whichever it asks first decides which fact answers it.
    [new RegExp(`${WORK_AUTH[0].source}|${WORK_AUTH[1].source}`), (p, l) => {
      const need = l.search(WORK_AUTH[0]);
      const allowed = l.search(WORK_AUTH[1]);
      if (allowed >= 0 && (need < 0 || allowed < need)) return p.work_authorization?.eligible_where_job_is ? 'Yes' : OTHER_COUNTRY.test(l) && !US.test(l) ? undefined : yn(p.work_authorization?.authorized_us);
      return yn(p.work_authorization?.needs_sponsorship);
    }],
    [/^(are|would) you (be )?(willing|open|able) to relocate$/, (p) => yn(p.preferences?.willing_to_relocate)],
    [/at least 18|over 18|18 years (of age|or older)/, (p) => yn(p.screening?.over_18)],
    [/^(are you )?(willing|able) to travel/, (p) => yn(p.preferences?.willing_to_travel)],
    [/driver s licen[sc]e/, (p) => yn(p.screening?.drivers_license)],
    [/(consent|willing|agree) to (a |undergo a )?background check/, (p) => yn(p.screening?.background_check_ok)],
    [/(consent|willing|agree) to (a |undergo a )?drug (test|screen)/, (p) => yn(p.screening?.drug_test_ok)],
    [/non ?compete|non ?solicit/, (p) => yn(p.screening?.non_compete)],
    [/(previously|ever) (been employed|worked)|worked (for|at|with) .* before|former employee/, (p) => yn(p.screening?.worked_here_before ?? (p.screening?.no_employer_ties ? false : undefined))],
    [/(relative|family member)s? (who )?(work|employed)/, (p) => yn(p.screening?.relatives_at_company)],
    [/security clearance/, (p) => p.screening?.security_clearance],
    [/(current|present|most recent) (or (most recent|current) )?(company|employer)/, (p) => p.current_company],
    [/(current|present|most recent) (or (most recent|current) )?(job )?title/, (p) => p.current_title],
    [/years of (relevant |professional |total |work )?experience do you have/, (p) => p.years_experience],
    // Ties to the employer itself, which for most applications are simply "No".
    [/are you an? .*\balum|parent of a (current|former)|family member or close personal relationship|conflicts? of interest/, (p) => (p.screening?.no_employer_ties ? 'No' : undefined)],
    [/date of birth|birth ?date|^dob$/, (p) => p.date_of_birth],
    [/referr(ed|al)( by| name)|who referred/, (p) => p.referral_name],
    [/highest (level of )?(education|degree)|education level/, (p) => p.highest_degree],
    [/graduation (year|date)|year of graduation/, (p) => p.graduation_year],
    [/^school|university|institution|college/, (p, l, i) => p.education?.[i]?.school],
    [/^degree|level of education/, (p, l, i) => p.education?.[i]?.degree],
    [/discipline|^major|field of study|area of study/, (p, l, i) => p.education?.[i]?.field],
    [/\bgpa\b/, (p, l, i) => p.education?.[i]?.gpa],
    [/^start (date )?year/, (p, l, i) => String(p.education?.[i]?.start || '').match(/\d{4}/)?.[0]],
    [/^end (date )?year/, (p, l, i) => String(p.education?.[i]?.end || '').match(/\d{4}/)?.[0]],
  ];
  // Rules that name a field ("Email", "City", "School") only apply to short labels. A long
  // question that merely mentions the word ("...please list the email of your manager") is not that field.
  const FIELD_RULES = 25;
  const EDUCATION_RULES = 6;
  const namesAField = (r) => r < FIELD_RULES || r >= RULES.length - EDUCATION_RULES;

  const CONSENT = /agree|consent|acknowledge|certify|attest|terms|privacy|policy|i understand|i have read|subscribe|marketing|newsletter|sms|text messages/;

  // Returns { value } when the profile answers the question, { manual } when the
  // field must be left to the person, or null when the AI should look at it.
  AM.rule = function (f, profile, counts) {
    const l = canon(f.label);
    const ac = (f.el.getAttribute('autocomplete') || '').toLowerCase();

    if (f.kind === 'file') return f === counts.resumeField ? { value: '__resume__' } : { manual: 'Other upload, left for you' };
    // Background and drug check questions are answered from the person's saved choice instead.
    if (f.kind !== 'text' && f.kind !== 'textarea' && CONSENT.test(l) && !/background check|drug (test|screen)/.test(l)) return { manual: 'Consent and attestations are yours to make' };

    for (const [re, key] of SENSITIVE) {
      if (!re.test(l)) continue;
      const v = profile.eeo?.[key];
      return v ? { value: v, sensitive: true } : { manual: 'Demographic question, no saved answer', sensitive: true };
    }

    // Numbered blocks ("Work Experience 2", "Education 1") map onto that entry of the profile.
    const block = canon(f.section).match(/(work )?experience (\d+)|employment (\d+)/);
    const job = block && profile.experience?.[+(block[2] || block[3]) - 1];
    if (job) {
      const n = +(block[2] || block[3]) - 1;
      const v =
        /description|responsibilit|accomplishment|duties/.test(l) ? { role: n } :
        /^(job )?title|^position|^role$/.test(l) ? job.title :
        /company|employer|organi[sz]ation/.test(l) ? job.company :
        /^location/.test(l) ? (n === 0 && counts.where ? counts.where.label : job.location) :
        /^(from|start)/.test(l) ? job.start :
        /^(to|end)\b/.test(l) ? (job.current ? undefined : job.end) :
        /currently work/.test(l) ? (job.current ? 'Yes' : undefined) : null;
      if (v?.role !== undefined) return v;
      if (v) return { value: String(v) };
      if (v === undefined) return null;
    }
    const school = canon(f.section).match(/education (\d+)/);

    // "If yes, please list..." only matters when the question before it applies.
    if (/^if (yes|so|you (have|are|were|selected|answered))\b/.test(l)) return { manual: 'Follow-up question, only needed if it applies to you' };
    if (counts.preferAI && AM.isWorkAuth(f)) return null;

    const byAc = {
      'given-name': profile.first_name, 'family-name': profile.last_name, email: profile.email, tel: profile.phone,
      organization: profile.current_company, 'postal-code': profile.address?.postal_code,
      'address-level2': profile.address?.city, 'address-level1': profile.address?.state,
    }[ac];
    if (byAc) return { value: String(byAc) };

    for (let r = 0; r < RULES.length; r++) {
      const [re, get] = RULES[r];
      if (!re.test(l)) continue;
      if (namesAField(r) && l.split(' ').length > 7) return null;
      const i = school ? +school[1] - 1 : counts[r] || 0;
      counts[r] = i + 1;
      const v = get(profile, l, i);
      return v === undefined || v === null || v === '' ? null : { value: String(v) };
    }
    return null;
  };

  // The upload that should receive the resume: one labelled as such, else the first plain upload.
  AM.resumeField = function (fields) {
    const files = fields.filter((f) => f.kind === 'file').map((f) => [f, canon(`${f.label} ${f.hint}`)]);
    const other = /cover|autofill|transcript|portfolio|photo|certificate/;
    return (files.find(([, h]) => /resume|\bcv\b|curriculum/.test(h) && !other.test(h)) || files.find(([, h]) => !other.test(h)))?.[0];
  };

  const DECLINE = /decline|prefer not|not wish|don t wish|not to (say|answer|disclose|identify|specify)|choose not|rather not/;
  const SYN = [
    ['united states', 'usa', 'us', 'united states of america', 'u s', 'u s a'],
    ['united kingdom', 'uk', 'great britain'],
    ['male', 'man'],
    ['female', 'woman'],
    ['bachelor s degree', 'bachelors', 'bachelor s', 'bs', 'ba', 'bachelor of science', 'bachelor of arts'],
    ['master s degree', 'masters', 'master s', 'ms', 'ma', 'master of science'],
  ];

  // Other ways the same thing is commonly written in a dropdown ("MS" vs "Master of Science").
  const DEGREES = [
    [/^(m ?s ?c?|m ?a|m ?eng|m ?tech|masters?( s)?( degree)?|master of \w+)$/, ["Master's Degree", 'Masters', 'Master of Science', 'Master of Arts', 'Master']],
    [/^(mba|master of business administration)$/, ['MBA', 'Master of Business Administration', "Master's Degree", 'Master']],
    [/^(b ?s ?c?|b ?a|b ?e|b ?eng|b ?tech|bba|b ?com|bachelors?( s)?( degree)?|bachelor of \w+)$/, ["Bachelor's Degree", 'Bachelors', 'Bachelor of Science', 'Bachelor of Arts', 'Bachelor']],
    [/^(ph ?d|doctorate|doctor of philosophy)$/, ['Doctorate', 'PhD', 'Doctor of Philosophy', 'Doctoral Degree']],
    [/^(associate( s)?( degree)?|a ?a|a ?s)$/, ["Associate's Degree", 'Associate']],
  ];
  const STATES = { alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY' };
  AM.variants = function (want) {
    const w = canon(want);
    const extra = DEGREES.find(([re]) => re.test(w))?.[1] || [];
    // "San Francisco, California" is often listed as "San Francisco, CA, USA".
    const m = String(want).match(/^(.+),\s*([A-Za-z ]+)$/);
    const code = m && STATES[m[2].trim().toLowerCase()];
    // A state on its own may be listed by name or by code ("GA" / "Georgia").
    const short = String(want).match(/^(.+),\s*([A-Za-z]{2})$/);
    const longName = short && Object.keys(STATES).find((n) => STATES[n] === short[2].toUpperCase());
    const spelled = longName ? [`${short[1]}, ${longName}`] : [];
    const alone = String(want).trim();
    const state = STATES[alone.toLowerCase()] || (/^[A-Za-z]{2}$/.test(alone) && Object.keys(STATES).find((n) => STATES[n] === alone.toUpperCase()));
    return [String(want), ...(code ? [`${m[1]}, ${code}`] : []), ...spelled, ...(state ? [state] : []), ...extra];
  };

  // Index of the option that matches `want` (or one of its variants) well, or -1.
  AM.pick = function (options, want) {
    for (const v of AM.variants(want)) {
      const i = pickOne(options, v);
      if (i >= 0) return i;
    }
    return -1;
  };

  // The closest option by shared words, for when nothing matches well: { idx, score 0..1 }.
  const FILLER = new Set(['of', 'the', 'and', 'in', 'for', 'a', 's', 'at', 'degree']);
  AM.best = function (options, want) {
    const words = (s) => new Set(canon(s).split(' ').filter((t) => t && !FILLER.has(t)));
    let best = { idx: -1, score: 0 };
    for (const v of AM.variants(want)) {
      const a = words(v);
      options.forEach((o, idx) => {
        const b = words(o);
        const shared = [...a].filter((t) => b.has(t)).length;
        const score = a.size && b.size ? (2 * shared) / (a.size + b.size) : 0;
        if (score > best.score) best = { idx, score };
      });
    }
    return best;
  };

  function pickOne(options, want) {
    const w = canon(want);
    if (!w) return -1;
    const opts = options.map(canon);
    let i = opts.indexOf(w);
    if (i >= 0) return i;
    if (DECLINE.test(w)) return opts.findIndex((o) => DECLINE.test(o));
    // A plain number against ranges: 9 belongs in "6-9 years", 12 in "10+ years".
    if (/^\d+(\.\d+)?$/.test(w)) {
      const n = +w;
      i = opts.findIndex((o) => {
        const range = o.match(/(\d+) (?:to )?(\d+)/);
        if (range) return n >= +range[1] && n <= +range[2];
        const plus = o.match(/(\d+)\+|(?:more than|over|at least) (\d+)/);
        if (plus) return n >= +(plus[1] || plus[2]);
        const under = o.match(/(?:less than|under|fewer than) (\d+)/);
        return under ? n < +under[1] : false;
      });
      if (i >= 0) return i;
    }
    if (w === 'yes' || w === 'no') {
      i = opts.findIndex((o) => o.split(' ')[0] === w);
      if (i >= 0) return i;
    }
    const syn = SYN.find((s) => s.includes(w));
    if (syn) {
      i = opts.findIndex((o) => syn.includes(o));
      if (i >= 0) return i;
    }
    i = opts.findIndex((o) => o.startsWith(w + ' ') || w.startsWith(o + ' '));
    if (i >= 0) return i;
    if (w.length > 3) {
      i = opts.findIndex((o) => o.includes(w) || (o.length > 3 && w.includes(o)));
      if (i >= 0) return i;
    }
    const wt = new Set(w.split(' '));
    let best = -1;
    let bestScore = 0.6;
    opts.forEach((o, j) => {
      const ot = [...new Set(o.split(' '))];
      const hit = ot.filter((t) => wt.has(t)).length;
      const score = hit / Math.max(wt.size, Math.min(ot.length, wt.size + 1));
      if (score > bestScore) [best, bestScore] = [j, score];
    });
    return best;
  }
})();
