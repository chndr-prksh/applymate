// Looks a posting up on Greenhouse's public job-board API, which gives the title,
// location and description reliably even when the page itself does not expose them.
const text = (html) => html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

export async function greenhouseLookup(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const tries = [];
  const m = u.host.includes('greenhouse.io') && u.pathname.match(/^\/(?:embed\/)?([^/]+)\/jobs\/(\d+)/);
  if (m) tries.push([m[1], m[2]]);
  // Company career sites that front a Greenhouse board carry the job id in gh_jid.
  const id = u.searchParams.get('gh_jid') || (u.searchParams.get('token') && u.host.includes('greenhouse.io') ? u.searchParams.get('token') : null);
  const board = u.searchParams.get('for');
  if (id && board) tries.push([board, id]);
  if (id) for (const part of u.host.split('.')) if (!/^(www|careers|jobs|boards|job-boards|greenhouse|com|co|io)$/.test(part)) tries.push([part, id]);
  for (const [b, j] of tries) {
    const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${b}/jobs/${j}`).catch(() => null);
    if (!res?.ok) continue;
    const job = await res.json();
    return { title: job.title, company: job.company_name || b, location: job.location?.name || '', jd: text(unescape(job.content || '')).slice(0, 6000) };
  }
  return null;
}

// Workday serves each posting's title, location and description as public data next
// to the page, which also works from any step of the application.
export async function workdayLookup(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/\.(myworkdayjobs|myworkdaysite)\.com$/.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/(?:[a-z]{2}-[A-Z]{2}\/)?(?:recruiting\/([^/]+)\/)?([^/]+)\/(job\/.+?)(?:\/apply(?:\/.*)?)?\/?$/);
  if (!m) return null;
  const tenant = m[1] || u.hostname.split('.')[0];
  const res = await fetch(`${u.origin}/wday/cxs/${tenant}/${m[2]}/${m[3]}`, { headers: { accept: 'application/json' } }).catch(() => null);
  if (!res?.ok) return null;
  const data = await res.json();
  const info = data.jobPostingInfo || {};
  const places = [info.location, ...(info.additionalLocations || [])].filter(Boolean).join('; ');
  return { title: info.title || '', company: (data.hiringOrganization?.name || tenant).replace(/^\d+\s+/, ''), location: places, jd: text(info.jobDescription || '').slice(0, 6000) };
}

// Ashby lists every open role of a company as public data.
export async function ashbyLookup(url) {
  const m = String(url).match(/jobs\.ashbyhq\.com\/([^/?#]+)\/([0-9a-f]{8}-[0-9a-f-]{27})/i);
  if (!m) return null;
  const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${m[1]}`).catch(() => null);
  if (!res?.ok) return null;
  const job = ((await res.json()).jobs || []).find((j) => j.id === m[2].toLowerCase());
  if (!job) return null;
  return { title: job.title, company: decodeURIComponent(m[1]), location: [job.location, ...(job.secondaryLocations || []).map((l) => l.location)].filter(Boolean).join('; '), jd: text(job.descriptionHtml || job.descriptionPlain || '').slice(0, 6000) };
}

export async function leverLookup(url) {
  const m = String(url).match(/jobs\.(?:eu\.)?lever\.co\/([^/?#]+)\/([0-9a-f]{8}-[0-9a-f-]{27})/i);
  if (!m) return null;
  const res = await fetch(`https://api.lever.co/v0/postings/${m[1]}/${m[2]}`).catch(() => null);
  if (!res?.ok) return null;
  const job = await res.json();
  const lists = (job.lists || []).map((l) => `${l.text}: ${text(l.content || '')}`).join(' ');
  return { title: job.text, company: m[1], location: job.categories?.allLocations?.join('; ') || job.categories?.location || '', jd: `${job.descriptionPlain || ''} ${lists} ${job.additionalPlain || ''}`.replace(/\s+/g, ' ').trim().slice(0, 6000) };
}

export async function workableLookup(url) {
  const m = String(url).match(/apply\.workable\.com\/([^/?#]+)\/j\/([A-Z0-9]+)/i);
  if (!m) return null;
  const res = await fetch(`https://apply.workable.com/api/v2/accounts/${m[1]}/jobs/${m[2]}`).catch(() => null);
  if (!res?.ok) return null;
  const job = await res.json();
  const l = job.location || {};
  return { title: job.title, company: m[1], location: [l.city, l.region, l.country].filter(Boolean).join(', '), jd: text(`${job.description || ''} ${job.requirements || ''}`).slice(0, 6000) };
}

export async function smartRecruitersLookup(url) {
  const m = String(url).match(/smartrecruiters\.com\/(?:oneclick-ui\/company\/)?([^/?#]+)\/(?:publication\/)?(\d{6,}|[0-9a-f]{8}-[0-9a-f-]{27})/i);
  if (!m) return null;
  const res = await fetch(`https://api.smartrecruiters.com/v1/companies/${m[1]}/postings/${m[2]}`).catch(() => null);
  if (!res?.ok) return null;
  const job = await res.json();
  const parts = Object.values(job.jobAd?.sections || {}).map((x) => `${x.title || ''}: ${x.text || ''}`).join(' ');
  return { title: job.name, company: job.company?.name || m[1], location: [job.location?.city, job.location?.region, job.location?.country].filter(Boolean).join(', '), jd: text(parts).slice(0, 6000) };
}

// The address of the description page behind an application-step address: the same
// address without its trailing apply / application / candidate / login part.
function descriptionPages(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return [];
  }
  const out = new Set();
  const stripped = u.pathname.replace(/\/(apply|application|applyManually|candidate|login|register|questions|review)(\/.*)?$/i, '');
  if (/\.icims\.com$/.test(u.hostname)) out.add(`${u.origin}${stripped}/job?in_iframe=1`);
  if (stripped !== u.pathname) out.add(`${u.origin}${stripped}${u.search}`);
  out.add(`${u.origin}${u.pathname}${u.search}`);
  return [...out];
}

// Last resort for boards with no public listing: fetch the description page itself
// and take the posting data embedded in it, or its text if that reads like a posting.
export async function fetchPostingPage(url) {
  for (const page of descriptionPages(url)) {
    const res = await fetch(page, { credentials: 'include' }).catch(() => null);
    if (!res?.ok) continue;
    const html = await res.text();
    for (const block of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
      let data;
      try {
        data = JSON.parse(block[1]);
      } catch {
        continue;
      }
      const post = [].concat(data['@graph'] || data).find((x) => x?.['@type'] === 'JobPosting');
      if (!post?.description) continue;
      const location = [].concat(post.jobLocation || []).map((l) => [l.address?.addressLocality, l.address?.addressRegion].filter((x) => typeof x === 'string' && x).join(', ')).filter(Boolean).join('; ');
      return { title: post.title || '', company: post.hiringOrganization?.name || '', location, jd: text(unescape(post.description)).slice(0, 6000), structured: true };
    }
    const body = text(html.replace(/<(nav|header|footer)[\s\S]*?<\/\1>/gi, ' '));
    if (looksLikePosting(body)) return { title: text((html.match(/<title>([^<]*)/i) || [])[1] || ''), company: '', location: '', jd: body.slice(0, 6000) };
  }
  return null;
}

// Tries the posting's own address first, then any addresses the page pointed to (an
// embedded job board on a company's careers page).
export async function lookupJob(url, hints = []) {
  for (const u of [url, ...hints]) {
    const found = (await greenhouseLookup(u)) || (await workdayLookup(u)) || (await ashbyLookup(u)) || (await leverLookup(u)) || (await workableLookup(u)) || (await smartRecruitersLookup(u));
    if (found?.jd) return found;
  }
  return null;
}

// Whether text reads like one job's posting (duties, requirements) rather than a
// careers landing page or a form. A resume is only tailored against the former.
export function looksLikePosting(jd) {
  const signs = [/responsibilit/i, /qualification/i, /requirement/i, /what you.?ll (do|bring|need)/i, /about the (role|job|position)/i, /you (will|have|are)\b/i, /we.?re looking for/i, /\d\+? years/i, /experience (with|in|building)/i];
  const t = String(jd || '');
  const good = signs.filter((re) => re.test(t)).length;
  // Consent, privacy and cookie pages mention "requirements" and "you are" too; they
  // only pass when the posting signals clearly outweigh them.
  const legal = (t.match(/consent|privacy (notice|policy|statement)|cookie|personal (data|information)|terms of use|data protection/gi) || []).length;
  // Judged by density, since a real posting can carry a privacy notice at the bottom.
  return t.length >= 1000 && good >= 3 && legal / (t.length / 1000) < 2.5;
}
