// Answers form questions with a model running on this computer through Ollama
// (https://ollama.com), so they cost nothing and nothing leaves the machine. The
// resume is still written by Claude.
export async function callLocal({ url, model, system, content, schema }) {
  const text = (x) => (typeof x === 'string' ? x : x.map((b) => b.text || '').join('\n\n'));
  let res;
  try {
    res = await fetch(`${url.replace(/\/+$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: false, format: schema, options: { temperature: 0 }, messages: [{ role: 'system', content: text(system) }, { role: 'user', content: text(content) }] }),
    });
  } catch {
    throw new Error(`Could not reach the local model at ${url}. Is Ollama running?`);
  }
  if (res.status === 403) throw new Error('Ollama refused the extension. Quit Ollama, then start it with OLLAMA_ORIGINS="chrome-extension://*" (see settings).');
  if (res.status === 404) throw new Error(`The local model "${model}" is not installed. Run: ollama pull ${model}`);
  if (!res.ok) throw new Error(`Local model error ${res.status}`);
  const data = await res.json();
  let parsed;
  try {
    parsed = JSON.parse(data.message?.content || '');
  } catch {
    throw new Error('The local model returned something that was not valid JSON.');
  }
  return { data: parsed, usage: { input_tokens: data.prompt_eval_count || 0, output_tokens: data.eval_count || 0 }, model: `local:${model}` };
}
