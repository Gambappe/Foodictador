/**
 * Typed, fail-fast parse of the environment (P0.3).
 *
 * Required: the XTrace base URL and key, the relay URL and token — the app cannot
 * mean anything without its stores, so a missing one is an error naming the variable.
 *
 * ANTHROPIC_API_KEY is deliberately NOT required: G5's acceptance gate must run green
 * with no key and no network, so its absence degrades flags (see flags.ts) instead of
 * throwing.
 */

export interface AppConfig {
  xtraceBaseUrl: string;
  xtraceApiKey: string;
  relayUrl: string;
  relayToken: string;
  anthropicApiKey: string | null;
  /**
   * Ingest→retrievable window in seconds, read by M7's sweeper and S3's loader.
   * The default is a placeholder at the top of design v0.8 §14's measured 5–8 minute
   * range; gate zero (P0.5) measures the real number and records it here (DAG D-3).
   */
  settleWindowSeconds: number;
}

const REQUIRED_VARS = [
  ['xtraceBaseUrl', 'XTRACE_BASE_URL'],
  ['xtraceApiKey', 'XTRACE_API_KEY'],
  ['relayUrl', 'RELAY_URL'],
  ['relayToken', 'RELAY_TOKEN'],
] as const;

export const DEFAULT_SETTLE_WINDOW_SECONDS = 480;

type Env = Record<string, string | undefined>;

function present(env: Env, name: string): string | null {
  const value = env[name];
  return value === undefined || value.trim() === '' ? null : value;
}

export function loadConfig(env: Env = process.env): AppConfig {
  const missing = REQUIRED_VARS.filter(([, name]) => present(env, name) === null).map(
    ([, name]) => name,
  );
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
  }

  const settleRaw = present(env, 'SETTLE_WINDOW_SECONDS');
  let settleWindowSeconds = DEFAULT_SETTLE_WINDOW_SECONDS;
  if (settleRaw !== null) {
    const parsed = Number(settleRaw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`SETTLE_WINDOW_SECONDS must be a positive number, got "${settleRaw}"`);
    }
    settleWindowSeconds = parsed;
  }

  const read = (name: string): string => {
    const value = present(env, name);
    if (value === null) throw new Error(`Missing required environment variable(s): ${name}`);
    return value;
  };

  return {
    xtraceBaseUrl: read('XTRACE_BASE_URL'),
    xtraceApiKey: read('XTRACE_API_KEY'),
    relayUrl: read('RELAY_URL'),
    relayToken: read('RELAY_TOKEN'),
    anthropicApiKey: present(env, 'ANTHROPIC_API_KEY'),
    settleWindowSeconds,
  };
}
