/**
 * Relay client (M4) — typed access to every P0.4 route.
 *
 * Every outbound read passes `parseRead` BEFORE any request is made: a bad body
 * never reaches the wire, so the server's 400 path is a backstop, not the guard.
 * Transport policy: bounded retry with backoff on 5xx and network errors; a 4xx
 * is NEVER retried — it means the request itself is wrong and will be wrong again.
 */

import type { Relay } from '../contracts/modules.js';
import type { Read, RelayEntry, RelayStats } from '../contracts/types.js';
import type { Logger } from '../config/logger.js';
import { parseRead } from '../kernel/read.js';

const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 200;

export class RelayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface RelayClientConfig {
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

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RelayError(`relay: unexpected ${context} response shape`);
  }
  return value as Record<string, unknown>;
}

export function createRelayClient(config: RelayClientConfig): Relay {
  const fetchFn = config.fetchFn ?? fetch;
  const sleepFn = config.sleepFn ?? defaultSleep;

  async function request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ status: number; json: unknown }> {
    let lastError: Error = new RelayError('relay: no attempt made');
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // The token rides every request as M11's header (P0.9/D-12). Mutations still
        // carry it in the body — the server checks there — but GETs have no body, and
        // an unheadered GET now gets the coarse public view: day-precision timestamps
        // in read_id order, no `since`. This client IS the operator's client — the
        // sweeper's settle window reads seconds off `received_at` — so it must always
        // identify itself.
        const init: RequestInit = { method, headers: { 'x-relay-token': config.token } };
        if (body !== undefined) {
          init.headers = { 'content-type': 'application/json', 'x-relay-token': config.token };
          init.body = JSON.stringify(body);
        }
        const res = await fetchFn(new URL(path, config.url), init);
        if (res.status >= 500) {
          lastError = new RelayError(`relay: ${method} ${path} failed with ${res.status}`, res.status);
        } else {
          const text = await res.text();
          let json: unknown = null;
          if (text !== '') {
            try {
              json = JSON.parse(text) as unknown;
            } catch {
              // A non-JSON body on a sub-500 status is a fact about the response,
              // not a transient fault — surface it without burning retries.
              throw new RelayError(
                `relay: ${method} ${path} returned invalid JSON (${res.status})`,
                res.status,
              );
            }
          }
          if (res.status >= 400) {
            const serverError =
              json !== null ? (asRecord(json, 'error')['error'] as string | undefined) : undefined;
            // A 4xx is a fact about the request — retrying resends the same mistake.
            throw new RelayError(
              `relay: ${method} ${path} rejected (${res.status})${serverError ? `: ${serverError}` : ''}`,
              res.status,
            );
          }
          return { status: res.status, json };
        }
      } catch (error) {
        if (error instanceof RelayError && error.status !== undefined && error.status < 500) {
          throw error; // the non-retried 4xx path
        }
        lastError = error instanceof Error ? error : new Error(String(error));
      }
      if (attempt < MAX_ATTEMPTS) await sleepFn(BACKOFF_BASE_MS * 2 ** (attempt - 1));
    }
    throw lastError;
  }

  function parseEntry(raw: unknown): RelayEntry | null {
    try {
      const record = asRecord(raw, 'relay entry');
      const read = parseRead(record['read']);
      const receivedAt = record['received_at'];
      if (typeof receivedAt !== 'string') throw new RelayError('entry missing received_at');
      const entry: RelayEntry = { read, received_at: receivedAt };
      const jobId = record['ingest_job_id'];
      if (typeof jobId === 'string' && jobId !== '') entry.ingest_job_id = jobId;
      // The ingest ledger (M10). This parser builds a FRESH object rather than spreading, which
      // is right — it is the boundary, and unknown fields must not travel inward. The cost is
      // that a new field is invisible until it is named here, and this one was: the handles
      // were on the entry, `curl` showed them, and `forget` still reported `skipped` because
      // they never survived the parse.
      const poolMemories = record['pool_memories'];
      if (Array.isArray(poolMemories)) {
        const ids = poolMemories.filter((id): id is string => typeof id === 'string' && id !== '');
        if (ids.length > 0) entry.pool_memories = ids;
      }
      return entry;
    } catch (error) {
      config.logger.line(
        `relay: skipping malformed entry: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  return {
    async put(read: Read): Promise<void> {
      const valid = parseRead(read); // throws before any request is made
      await request('POST', '/reads', { token: config.token, read: valid });
    },

    async setJob(readId: string, jobId: string): Promise<void> {
      await request('POST', `/reads/${encodeURIComponent(readId)}/ingest-job`, {
        token: config.token,
        ingest_job_id: jobId,
      });
    },

    async setPoolMemories(readId: string, memoryIds: readonly string[]): Promise<void> {
      // The ingest ledger (M10). Best-effort like setJob and for the same reason: a failure
      // here costs `forget` its pool handles, which is a weaker deletion promise — not a lost
      // read. The sweeper logs it and carries on.
      await request('POST', `/reads/${encodeURIComponent(readId)}/memories`, {
        token: config.token,
        pool_memories: [...memoryIds],
      });
    },

    async list(since?: string): Promise<RelayEntry[]> {
      const path = since === undefined ? '/reads' : `/reads?since=${encodeURIComponent(since)}`;
      const { json } = await request('GET', path);
      if (!Array.isArray(json)) throw new RelayError('relay: list response is not an array');
      return json.map(parseEntry).filter((entry): entry is RelayEntry => entry !== null);
    },

    async drop(readId: string): Promise<void> {
      try {
        await request('DELETE', `/reads/${encodeURIComponent(readId)}`, { token: config.token });
      } catch (error) {
        // Already gone is the caller-facing contract (stub semantics; M8 treats
        // forget-of-unknown as success). Anything else propagates.
        if (error instanceof RelayError && error.status === 404) return;
        throw error;
      }
    },

    async stats(): Promise<RelayStats> {
      const { json } = await request('GET', '/stats');
      const record = asRecord(json, 'stats');
      const count = record['count'];
      const oldest = record['oldest_entry_age_seconds'];
      if (typeof count !== 'number' || typeof oldest !== 'number') {
        throw new RelayError('relay: stats response missing count/oldest_entry_age_seconds');
      }
      return { count, oldest_entry_age_seconds: oldest };
    },

    async seed(reads: Read[]): Promise<number> {
      // Validate the whole batch client-side first — one bad read stops the batch
      // before a single byte is sent, naming the index like the server would.
      const validated = reads.map((read, index) => {
        try {
          return parseRead(read);
        } catch (error) {
          throw new RelayError(
            `relay: reads[${index}] invalid, nothing sent: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
      const { json } = await request('POST', '/seed', { token: config.token, reads: validated });
      const count = asRecord(json, 'seed')['count'];
      if (typeof count !== 'number') throw new RelayError('relay: seed response missing count');
      return count;
    },

    async reset(): Promise<void> {
      await request('POST', '/reset', { token: config.token });
    },
  };
}
