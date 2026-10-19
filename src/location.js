// Decides which location an application uses, from the posting's location text and
// the person's own saved locations. The same answer drives the resume's two location
// spots and the form's city / state / ZIP / country fields, so they always agree.

const STATES = { alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC' };
const CODES = new Set(Object.values(STATES));
const CITY_STATE = { 'new york': 'NY', 'new york city': 'NY', nyc: 'NY', 'san francisco': 'CA', 'los angeles': 'CA', seattle: 'WA', chicago: 'IL', boston: 'MA', austin: 'TX', atlanta: 'GA', denver: 'CO', 'mountain view': 'CA', 'palo alto': 'CA', 'san jose': 'CA', 'washington': 'DC' };
const US = /^(united states( of america)?|u\.?s\.?a?\.?|america)$/i;
const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

// "Atlanta, Georgia, United States; New York City" -> [{ city, state, country }, ...]
export function parsePosting(text) {
  const out = [];
  for (const piece of String(text || '').split(/\s*(?:;|•|\||\/|\bor\b)\s*/i)) {
    const parts = piece.split(',').map((p) => p.trim()).filter(Boolean);
    if (!parts.length || /remote|anywhere|hybrid|multiple|various/i.test(piece)) continue;
    let [city, region, country] = parts;
    // Workday style: "US, CA, Santa Clara" (also written "US-CA-Santa Clara").
    const wd = piece.match(/^(?:US|USA)\s*[,-]\s*([A-Z]{2})\s*[,-]\s*(.+)$/);
    if (wd) [city, region, country] = [wd[2].trim(), wd[1], 'United States'];
    if (US.test(city)) continue;
    if (/^(new york city|nyc)$/i.test(city)) city = 'New York';
    let state = '';
    if (region) {
      if (CODES.has(region.toUpperCase()) && region.length === 2) state = region.toUpperCase();
      else if (STATES[region.toLowerCase()]) state = STATES[region.toLowerCase()];
      else if (/^(england|scotland|wales|northern ireland|uk)$/i.test(region)) country = 'United Kingdom';
      else if (US.test(region)) country = 'United States';
      else country = region;
    }
    if (!state && !country) state = CITY_STATE[city.toLowerCase()] || '';
    // A bare region name ("San Francisco Bay Area", "EMEA") is not a usable address.
    if (!state && !country) continue;
    const us = state || US.test(country || '') || US.test(region || '');
    out.push({ city, state, country: us ? 'United States' : country || '', region: state || us ? '' : region || '' });
  }
  return out;
}

// Returns null when the application should simply use the person's own address:
// the job is where they already are, is remote, or states no location.
export function resolveLocation(postingText, profile) {
  const options = parsePosting(postingText);
  if (!options.length) return null;
  const home = profile.address || {};
  const saved = profile.locations || [];
  // Preference: home if the posting offers it, then a saved location (in the order
  // the person listed them), then the posting's first.
  if (options.some((o) => same(o.city, home.city))) return null;
  // Anything that mentions the home city ("San Francisco Bay Area") counts as home.
  if (home.city && String(postingText).toLowerCase().includes(home.city.toLowerCase())) return null;
  const pick = saved.map((s) => options.find((o) => same(o.city, s.city))).find(Boolean) || options.find((o) => same(o.city, home.city)) || options[0];
  if (same(pick.city, home.city)) return null;
  const mine = saved.find((s) => same(s.city, pick.city)) || {};
  const state = mine.state || pick.state;
  const country = mine.country || pick.country;
  return {
    city: pick.city,
    state,
    country,
    postal_code: mine.postal_code || '',
    line1: mine.line1 || '',
    label: state ? `${pick.city}, ${state}` : [pick.city, pick.region || country].filter(Boolean).join(', '),
  };
}

// resolveLocation, plus the state when the posting leaves it out ("Niskayuna, United
// States of America"). A US location is always written "City, ST": the state is read
// from the job description if it says so there, otherwise looked up by city name. If
// neither finds it, the person's own location is kept rather than writing a country.
export async function locateApplication(postingText, profile, jdText = '') {
  const where = resolveLocation(postingText, profile);
  if (!where || where.country !== 'United States' || where.state) return where;
  const city = where.city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const near = `${postingText} ${jdText}`.match(new RegExp(`${city},?\\s+(?:([A-Z]{2})\\b|(${Object.keys(STATES).join('|')}))`, 'i'));
  let state = near && (near[1] && CODES.has(near[1].toUpperCase()) ? near[1].toUpperCase() : STATES[(near[2] || '').toLowerCase()]);
  if (!state) {
    const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(where.city)}&count=5&countryCode=US`).catch(() => null);
    const hits = res?.ok ? (await res.json()).results || [] : [];
    // Several places can share a name; the largest is the likeliest office location.
    const top = hits.filter((h) => same(h.name, where.city)).sort((a, b) => (b.population || 0) - (a.population || 0))[0];
    state = top && STATES[(top.admin1 || '').toLowerCase()];
  }
  return state ? { ...where, state, label: `${where.city}, ${state}` } : null;
}
