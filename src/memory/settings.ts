/**
 * Settings client (M11) — durable per-profile storage for what the user DECLARED.
 *
 * DAG §4 D-8 splits by who authored a fact and what it is for. This side holds the
 * assertions: allergies, intolerances, budget band, portion preference, solo comfort,
 * off-limits topics, the meal log. The user stated them and expects them honoured exactly, so
 * they need a store with addressing and upsert — which XTrace has neither of.
 *
 * ## Why this exists at all
 *
 * M3 originally kept settings in XTrace as "tagged JSON records", which needed three
 * prostheses for three missing primitives: a `kind` field used as a *search query* to stand
 * in for addressing, `written_at` ordering to arbitrate the duplicates a missing upsert
 * guarantees, and a JSON body to survive extraction. All three failed simultaneously, because
 * XTrace extracts prose and the extraction drops the tag *and* the JSON. Probed live across
 * three queries on two profiles: **0 rows carrying `confit:usual`, 0 verbatim-JSON rows.** So
 * `usual()` returned `null` on every cross-process read, which took out `confit ask` and
 * `confit confess` together — the latter because it reads `usual()` for the off-limits list.
 *
 * The requirement was never "a tag and a structure". It was a keyed store, and P0.8 built one:
 * every relay mutation is written atomically and fsynced *before* it is acknowledged, which is
 * the guarantee an allergy list actually needs. `~11/16` non-deterministic retention is not a
 * quality trade-off here — a dropped off-limits topic is a confession that should have been
 * blocked, written to the pool.
 *
 * ## Transport policy
 *
 * Matches M4's relay client deliberately, because it is the same service and an operator
 * debugging one should not find two retry stories: bounded retry with backoff on 5xx and
 * network faults, and a 4xx is **never** retried because the request itself is wrong and will
 * be wrong again.
 *
 * A read failure propagates. It must not be softened into "no settings", because
 * `usual() === null` is what X2 reads as "this profile was never provisioned" — turning an
 * unreachable relay into an empty off-limits list is exactly the failure D-8 moved this data
 * to avoid.
 */

import type { SettingsStore } from '../contracts/modules.js';
import type { Logger } from '../config/logger.js';

const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 200;

export class SettingsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SettingsError';
  }
}

export interface SettingsClientConfig {
  url: string;
  token: string;
  logger: Logger;
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Injectable for tests; defaults to a real timer. */
  sleepFn?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `/settings/{profile}/{key}`, each segment encoded so a slash in an id cannot add a path. */
function settingsPath(profile: string, key: string): string {
  return `/settings/${encodeURIComponent(profile)}/${encodeURIComponent(key)}`;
}

export function createSettingsClient(config: SettingsClientConfig): SettingsStore {
  const fetchFn = config.fetchFn ?? fetch;
  const sleepFn = config.sleepFn ?? defaultSleep;

  async function request(
    method: 'GET' | 'PUT',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    let lastError: Error = new SettingsError('settings: no attempt made');
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const init: RequestInit = { method };
        if (method === 'GET') {
          // The token goes in a header on reads: clients do not send GET bodies, and the
          // relay requires it here because settings — unlike pool reads — identify a person.
          init.headers = { 'x-relay-token': config.token };
        } else {
          init.headers = { 'content-type': 'application/json' };
          init.body = JSON.stringify({ token: config.token, ...body });
        }
        const res = await fetchFn(new URL(path, config.url), init);
        if (res.status >= 500) {
          lastError = new SettingsError(
            `settings: ${method} ${path} failed with ${String(res.status)}`,
            res.status,
          );
        } else {
          const text = await res.text();
          if (res.status >= 400) {
            // A 4xx is a fact about the request — retrying resends the same mistake.
            throw new SettingsError(
              `settings: ${method} ${path} rejected (${String(res.status)}): ${text}`,
              res.status,
            );
          }
          if (text === '') return null; // 204 from a PUT
          try {
            return JSON.parse(text) as unknown;
          } catch {
            throw new SettingsError(
              `settings: ${method} ${path} returned invalid JSON (${String(res.status)})`,
              res.status,
            );
          }
        }
      } catch (error) {
        if (error instanceof SettingsError && error.status !== undefined && error.status < 500) {
          throw error; // the non-retried 4xx path
        }
        lastError = error instanceof Error ? error : new Error(String(error));
      }
      if (attempt < MAX_ATTEMPTS) await sleepFn(BACKOFF_BASE_MS * 2 ** (attempt - 1));
    }
    throw lastError;
  }

  return {
    async get(profile: string, key: string): Promise<unknown> {
      const json = await request('GET', settingsPath(profile, key));
      if (typeof json !== 'object' || json === null || Array.isArray(json)) {
        throw new SettingsError('settings: unexpected get response shape');
      }
      // `value` is deliberately handed back unparsed. The boundary parser is M3's
      // (`parseUsualProfile`), so exactly one implementation decides what a valid profile is
      // — a check here would be a second copy of that rule, free to drift.
      return (json as Record<string, unknown>)['value'] ?? null;
    },

    async put(profile: string, key: string, value: unknown): Promise<void> {
      await request('PUT', settingsPath(profile, key), { value });
      config.logger.line(`settings: wrote ${key} for profile ${profile}`);
    },
  };
}
