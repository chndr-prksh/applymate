import { lookupJob } from '../src/jobs.js';

// Fetches a job posting (title, company, location, description) from its public listing.
const text = (html) => html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const json = async (url) => (await fetch(url)).json();

export async function fetchJob(url) {
  const u = new URL(url);
  let m;
  const found = await lookupJob(url);
  if (found) return { url, ...found };
  if (u.host === 'jobs.ashbyhq.com' && (m = u.pathname.match(/^\/([^/]+)\/([0-9a-f-]{36})/))) {
    const board = await json(`https://api.ashbyhq.com/posting-api/job-board/${m[1]}`);
    const j = board.jobs.find((x) => x.id === m[2]);
    if (j) return { url, title: j.title, company: m[1], location: j.location || '', jd: j.descriptionPlain.replace(/\s+/g, ' ').trim().slice(0, 6000) };
  }
  const html = await (await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } })).text();
  // A careers page that shows the job through an embedded board: find the board and look the posting up there.
  const ashbyOrg = html.match(/jobs\.ashbyhq\.com\/([^/?"'\s]+)/)?.[1];
  const hinted = u.searchParams.get('ashby_jid') && ashbyOrg && (await lookupJob(`https://jobs.ashbyhq.com/${ashbyOrg}/${u.searchParams.get('ashby_jid')}`));
  if (hinted) return { url, ...hinted };
  const ld = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((x) => { try { return JSON.parse(x[1]); } catch { return null; } }).flat().find((x) => x?.['@type'] === 'JobPosting');
  if (ld) {
    const a = [].concat(ld.jobLocation || [])[0]?.address || {};
    return { url, title: ld.title, company: ld.hiringOrganization?.name || u.host, location: [a.addressLocality, a.addressRegion].filter(Boolean).join(', '), jd: text(unescape(ld.description)).slice(0, 6000) };
  }
  return { url, title: (html.match(/<title>([^<]*)/i) || [])[1] || url, company: u.host, location: '', jd: text(html).slice(0, 6000) };
}

export const fileName = (job) => `${job.company}-${job.title}`.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70);
const flat = (c) => (typeof c === 'string' ? c : c.map((b) => b.text).join('\n\n'));
export const promptText = (req) => `===== SYSTEM =====\n${req.system}\n\n===== USER =====\n${flat(req.content)}\n\n===== REQUIRED RESPONSE SHAPE =====\n${JSON.stringify(req.schema, null, 1)}\n`;
