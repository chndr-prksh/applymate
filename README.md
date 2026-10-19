# ApplyMate

Chrome extension that fills the job application form in front of you from your profile and resume, tailors your resume to each job, and tracks what you applied to. It never clicks Next or Submit.

## Set up

```bash
npm install
npm run build
```

Open `chrome://extensions`, turn on Developer mode, choose **Load unpacked** and pick this folder. In the settings page that opens: load your profile, upload your resume PDF, and add a Claude API key.

## How it works

- **Job description first.** The posting is read from the job board's public listing (Greenhouse, Workday, Ashby, Lever, Workable, SmartRecruiters), from the description page behind an apply link, or from a posting opened recently on the same site. If none is found, the panel asks for the posting link or text.
- **Form questions.** Profile rules answer the common fields instantly. Everything else on a page goes in one request to Claude Haiku (or a local Ollama model), with a short candidate fact sheet instead of the whole profile.
- **Resume.** Claude rewrites only the summary and bullets of your own resume, inside its original layout (`src/resume-doc.js`); line counts are measured and corrected. Pages after the first are carried over from your original PDF.
- **Location.** One decision from the posting drives the resume header, the current-role line and the form's city, state, ZIP and country.
- **Tracker.** Every job is recorded with the exact resume sent, its AI cost, and a warning when you reopen a job you applied to.
- **Prompt log.** Every request and response is kept in settings for review.

## Layout

| Path | What it is |
|---|---|
| `content/` | Page scripts: scanning fields, rules, filling, the panel |
| `src/` | Service worker (bundled to `dist/`): Claude calls, job lookup, location, resume rendering |
| `options/` | Settings page |
| `tools/` | Command-line resume tailoring (`tailor.mjs`) and preview (`simulate.mjs`) |
| `test/` | Playwright tests against fixtures and live job boards |

## Tests

```bash
CHROMIUM=/path/to/chromium MOCK_AI=1 node test/run.mjs "<application url>"
node test/tracker.mjs
node test/jd.mjs
node test/quiet.mjs
```

`MOCK_AI=1` uses a local stand-in for the Claude API, so no key is needed.
