// One place that talks to the Claude API, shared by the extension's service worker
// and the command-line resume preview (tools/tailor.mjs).
import Anthropic from '@anthropic-ai/sdk';

function explain(e) {
  if (e instanceof Anthropic.AuthenticationError) return 'Your API key was rejected. Check it in settings.';
  if (e instanceof Anthropic.PermissionDeniedError) return 'Your API key does not have access to this model.';
  if (e instanceof Anthropic.NotFoundError) return 'The model set in settings was not found.';
  if (e instanceof Anthropic.RateLimitError) return 'Rate limited by the API. Try again in a moment.';
  if (e instanceof Anthropic.APIConnectionError) return 'Could not reach the Claude API. Check your connection.';
  if (e instanceof Anthropic.APIError) return `Claude API error ${e.status}: ${e.message}`;
  return e.message;
}

// Sends one request and returns { data, usage, model }: the parsed JSON answer (which
// must match `schema`), the token counts, and the model that actually answered.
export async function callClaude({ apiKey, baseURL, model, fast, system, content, schema }) {
  const client = new Anthropic({ apiKey, baseURL: baseURL || undefined, dangerouslyAllowBrowser: true });
  // Haiku 4.5 takes neither the effort setting nor refusal fallbacks.
  const basic = model.startsWith('claude-haiku');
  const params = {
    model,
    max_tokens: 16000,
    system,
    messages: [{ role: 'user', content }],
    output_config: { format: { type: 'json_schema', schema }, ...(basic ? {} : { effort: 'low' }) },
  };

  let res;
  try {
    if (basic) res = await client.messages.create(params);
    else {
      // Fast mode (Opus only) trades about double the price for quicker output.
      const quick = fast && model.startsWith('claude-opus-5');
      try {
        res = await client.beta.messages.create({
          ...params,
          betas: ['server-side-fallback-2026-07-01', ...(quick ? ['fast-mode-2026-02-01'] : [])],
          fallbacks: 'default',
          ...(quick ? { speed: 'fast' } : {}),
        });
      } catch (e) {
        // If an optional extra is rejected, the plain request still answers.
        if (!(e instanceof Anthropic.BadRequestError)) throw e;
        res = await client.messages.create(params);
      }
    }
  } catch (e) {
    throw new Error(explain(e));
  }

  if (res.stop_reason === 'refusal') throw new Error('The model declined this request.');
  if (res.stop_reason === 'max_tokens') throw new Error('The answer was cut off. Try again.');
  const text = res.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('The model returned no answer.');
  return { data: JSON.parse(text), usage: res.usage, model: res.model || model };
}
