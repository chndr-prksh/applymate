// A stand-in for the Messages API so the AI path can be exercised without a key.
// It answers every field with its first option or a canned sentence, returns a
// canned tailored resume, and counts requests so tests can check how many were made.
import http from 'node:http';

// A stand-in for Ollama's chat endpoint, answering the same way.
export function startMockOllama() {
  const calls = { chat: 0, model: '', promptChars: 0 };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const r = JSON.parse(body);
        calls.chat++;
        calls.model = r.model;
        calls.promptChars += r.messages.map((m) => m.content).join('').length;
        const user = r.messages.at(-1).content;
        let out;
        if (user.includes('<options>')) out = { choice: JSON.parse(user.slice(user.indexOf('<options>') + 9, user.indexOf('</options>'))).at(0) };
        else {
          const fields = JSON.parse(user.slice(user.indexOf('<fields>') + 8, user.indexOf('</fields>')));
          out = { answers: fields.map((f) => ({ id: f.id, values: [f.options?.[0] || (f.kind === 'number' ? String(f.max || 3) : 'LOCAL ANSWER')].filter(Boolean), confident: false })) };
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ model: r.model, message: { role: 'assistant', content: JSON.stringify(out) }, prompt_eval_count: 900, eval_count: 120 }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() }));
  });
}

export function startMockClaude() {
  const calls = { map: 0, tailor: 0, fields: 0, choose: 0 };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
      if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const request = JSON.parse(body);
        const sent = request.messages[0].content;
        const text = typeof sent === 'string' ? sent : sent.map((b) => b.text || '').join('\n');
        const fill = (n) => 'Shipped governed AI features with evaluation gates and guardrails for enterprise customers at scale. '.repeat(6).slice(0, n).trim();
        let out;
        if (text.includes('<fields>')) {
          const fields = JSON.parse(text.slice(text.indexOf('<fields>') + 8, text.indexOf('</fields>')));
          calls.map++;
          calls.answerModel = request.model;
          calls.previous = (JSON.stringify(request.system).match(/<previous_answers>(.*?)<\/previous_answers>/) || [])[1] || '';
          calls.fields += fields.length;
          out = { answers: fields.map((f) => ({ id: f.id, values: [f.options?.[0] || (f.kind === 'checkbox' ? '' : f.kind === 'date' ? '2026-11-16' : f.kind === 'number' ? String(f.max || 3) : 'MOCK ANSWER')].filter(Boolean), confident: false })) };
        } else if (text.includes('<options>')) {
          // Stand-in for judgement: take the last option, so tests can tell it apart from "first".
          calls.choose++;
          out = { choice: JSON.parse(text.slice(text.indexOf('<options>') + 9, text.indexOf('</options>'))).at(-1) };
        } else if (text.includes('<profile_and_answers>')) {
          calls.brief = (calls.brief || 0) + 1;
          out = { brief: 'work authorization: authorized, no sponsorship\ncurrent role: Senior Software Engineer, Northwind Labs, 7 years\nsalary: 180000' };
        } else if (text.includes('<corrections>')) {
          // A follow-up: rewrite only the listed pieces, to the middle of the asked range.
          calls.tailor++;
          calls.fixes = (calls.fixes || 0) + 1;
          out = { pieces: [...text.matchAll(/- (summary|role \d+, bullet \d+): .*?Rewrite it to (\d+)-(\d+) characters/g)].map((m) => ({ piece: m[1], text: fill(Math.round((+m[2] + +m[3]) / 2)) })) };
        } else {
          calls.tailor++;
          calls.resumeModel = request.model;
          calls.sawJob = /<job [^>]*>\s*\S/.test(text);
          calls.job = (text.match(/<job [^>]*>\n[\s\S]{0,160}/) || [''])[0].replace(/\s+/g, ' ');
          out = {
            location: 'New York, NY',
            summary: 'MOCK TAILORED SUMMARY. Backend-leaning engineer with seven years building data-heavy products, matched to this role.',
            skills: ['PostgreSQL', 'TypeScript', 'AWS', 'Python'],
            experience: [
              { index: 0, bullets: ['Rebuilt the reporting pipeline on Postgres and Kafka, cutting report latency from 4 minutes to 6 seconds.', 'Designed a multi-tenant billing service in TypeScript on AWS.', 'Mentored four engineers.'] },
              { index: 1, bullets: ['Built internal billing APIs in Python.', 'Shipped a React admin console used by a finance team of 30.'] },
            ],
          };
        }
        res.writeHead(200, { 'content-type': 'application/json', ...cors });
        res.end(JSON.stringify({
          id: 'msg_mock', type: 'message', role: 'assistant', model: request.model, stop_reason: 'end_turn', stop_sequence: null,
          content: [{ type: 'text', text: JSON.stringify(out) }], usage: { input_tokens: Math.round(JSON.stringify(request).length / 4), output_tokens: Math.round(JSON.stringify(out).length / 4) },
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() }));
  });
}
