// Estimated cost of one request, from the token counts the API reports and list
// prices in US dollars per million tokens: [input, output, cache read].
const PRICES = {
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-opus-5': [5, 25, 0.5],
  'claude-opus-4-8': [5, 25, 0.5],
  'claude-sonnet-5-5': [2, 10, 0.2],
  'claude-sonnet-5': [2, 10, 0.2],
  'claude-haiku-4-5': [1, 5, 0.1],
};

export function costOf(model, usage = {}, fast = false) {
  const key = Object.keys(PRICES).find((k) => model === k) || Object.keys(PRICES).find((k) => model?.startsWith(k));
  if (!key) return null;
  const [input, output, cacheRead] = PRICES[key];
  // Fast mode on Opus 5.5 is billed at double; writing to the cache costs 1.25x input.
  const times = fast && key === 'claude-opus-5-5' ? 2 : 1;
  // Cache writes: 1.25x input for the 5-minute cache, 2x for the one-hour cache.
  const hour = usage.cache_creation?.ephemeral_1h_input_tokens || 0;
  const writes = (usage.cache_creation_input_tokens || 0) - hour;
  const dollars = ((usage.input_tokens || 0) * input + writes * input * 1.25 + hour * input * 2 + (usage.cache_read_input_tokens || 0) * cacheRead + (usage.output_tokens || 0) * output) / 1e6;
  return times * dollars;
}

export const tokensOf = (usage = {}) => ({
  in: (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0),
  out: usage.output_tokens || 0,
});
