/**
 * What a turn would have cost on the API.
 *
 * Claude Code subscriptions are not billed per token, so these figures are an
 * *API-equivalent* — useful for comparing one session against another, not a bill.
 *
 * Token counts are the ground truth and are reported alongside: prices drift and new
 * models appear, but the counts in the transcript stay true, so a stale table can
 * always be re-checked against them.
 */

/** Anthropic list prices, $ per million tokens, as [input, output]. */
export const PRICES = {
  "claude-fable-5-1": [10, 50],
  "claude-fable-5": [10, 50],
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-opus-4-7": [5, 25],
  "claude-opus-4-6": [5, 25],
  "claude-sonnet-5": [2, 10],
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-4-5": [1, 5],
};

// Cache is charged against the input rate: reads are cheap, writes carry a premium.
const CACHE_READ = 0.1;
const CACHE_WRITE_5M = 1.25;
// UNVERIFIED: the 1h write multiplier has not been confirmed against Anthropic's
// published pricing. It moves the day total by a few percent but not the ranking of
// sessions, which is what the timeline is read for. Confirm before quoting absolutes.
const CACHE_WRITE_1H = 2.0;

/**
 * Cost in USD and the raw token count for one assistant turn.
 * An unpriced model yields `cost: null` — counted, never silently valued at zero.
 */
export function priceTurn(model, usage) {
  if (!usage) return { cost: 0, tokens: 0 };

  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const write5m = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  // Older transcripts carry only the total; treat it as the cheaper 5m write.
  const writeTotal = usage.cache_creation_input_tokens ?? 0;
  const write5mFinal = write5m || write1h ? write5m : writeTotal;

  const tokens = input + output + cacheRead + write5mFinal + write1h;
  const rate = PRICES[model];
  if (!rate) return { cost: null, tokens };

  const [inRate, outRate] = rate;
  const cost =
    (input * inRate +
      output * outRate +
      cacheRead * inRate * CACHE_READ +
      write5mFinal * inRate * CACHE_WRITE_5M +
      write1h * inRate * CACHE_WRITE_1H) /
    1e6;

  return { cost, tokens };
}
