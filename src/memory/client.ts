/**
 * MemoryClient over XTrace (M1).
 *
 * The scope (user_id) is a required positional parameter on every method — design
 * v0.8 §14: omitting it searches app-wide across both tiers. No overload here (or
 * anywhere) may make it optional; client.test.ts pins that at the type level.
 *
 * Endpoint paths are recorded in ./README.md (DAG §4 D-2). They are UNCONFIRMED
 * against the live API in this checkout — confirm during gate zero and update the
 * README before trusting anything beyond the interface.
 */

import type { MemoryClient } from '../contracts/modules.js';
import type { IngestJobStatus, JobHandle, MemoryRow, SearchOpts } from '../contracts/types.js';

export interface HttpRequest {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: Record<string, unknown>;
}

export interface HttpResponse {
  status: number;
  json: unknown;
}

/** Injectable transport so the whole suite runs with no network (DAG §1). */
export interface HttpTransport {
  request(req: HttpRequest): Promise<HttpResponse>;
}

export interface MemoryClientConfig {
  baseUrl: string;
  apiKey: string;
}

export function createFetchTransport(config: MemoryClientConfig): HttpTransport {
  return {
    async request(req: HttpRequest): Promise<HttpResponse> {
      const init: RequestInit = {
        method: req.method,
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
        },
      };
      if (req.body !== undefined) init.body = JSON.stringify(req.body);
      const res = await fetch(new URL(req.path, config.baseUrl), init);
      const text = await res.text();
      return { status: res.status, json: text === '' ? null : (JSON.parse(text) as unknown) };
    },
  };
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`xtrace: unexpected ${context} response shape`);
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string, context: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`xtrace: ${context} response missing "${key}"`);
  }
  return value;
}

/**
 * Search rows. The wire shape is `{data: [{id, type, text, ...}]}` — confirmed against
 * the live API, see README. It is NOT `{rows: [{memory_id, kind, content}]}`, which is
 * what this file assumed before anyone had credentials.
 */
function parseRows(value: unknown): MemoryRow[] {
  const record = asRecord(value, 'search');
  const rows = record['data'];
  if (!Array.isArray(rows)) throw new Error('xtrace: search response missing "data"');
  const parsed: MemoryRow[] = [];
  for (const raw of rows) {
    const row = asRecord(raw, 'search row');
    const kind = row['type'];
    if (kind !== 'fact' && kind !== 'episode') continue; // unknown kinds are skipped, not fatal
    parsed.push({
      memoryId: requireString(row, 'id', 'search row'),
      kind,
      content: typeof row['text'] === 'string' ? row['text'] : '',
    });
  }
  return parsed;
}

/**
 * Live job vocabulary, confirmed: `pending` → `running` → `succeeded`, or `failed`.
 * `succeeded` is the terminal success value; the earlier guess was `complete`, which
 * never appears, so every poll fell through to `unknown` and no verification could pass.
 */
const TERMINAL_SUCCESS = 'succeeded';

export function createMemoryClient(transport: HttpTransport): MemoryClient {
  async function call(req: HttpRequest, context: string): Promise<unknown> {
    const res = await transport.request(req);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`xtrace: ${context} failed with status ${res.status}`);
    }
    return res.json;
  }

  /** One message, one fresh conversation. Shared by `ingest` and nothing else. */
  async function single(scope: string, payload: string): Promise<JobHandle> {
    const json = await call(
      {
        method: 'POST',
        path: '/v1/memories',
        body: {
          user_id: scope,
          conv_id: `confit-${scope}-${crypto.randomUUID()}`,
          messages: [{ role: 'user', content: payload }],
        },
      },
      'ingest',
    );
    // The handle is `id`, not `job_id`.
    return { jobId: requireString(asRecord(json, 'ingest'), 'id', 'ingest') };
  }

  return {
    async ingest(scope: string, payload: string): Promise<JobHandle> {
      // The API is conversation-shaped: `messages` plus a `conv_id`, not a bare
      // `content` string. A body without all three is rejected 422 naming the fields.
      // A random `conv_id` is right HERE and only here: one prose confession is one
      // conversation of one message, which is what keeps the payload byte-identical
      // ([E11]). It is wrong for the pool, and was used there — see `ingestBatch`.
      return single(scope, payload);
    },

    async ingestBatch(
      scope: string,
      payloads: readonly string[],
      convId: string,
    ): Promise<JobHandle> {
      if (payloads.length === 0) throw new Error('xtrace: ingestBatch called with no payloads');
      const json = await call(
        {
          method: 'POST',
          path: '/v1/memories',
          body: {
            user_id: scope,
            // The caller's id, not a fresh one. That IS the feature: episodes are
            // conversation summaries, so what shares a conv_id is what a claim can be
            // synthesised across (M12).
            conv_id: convId,
            messages: payloads.map((content) => ({ role: 'user', content })),
          },
        },
        'ingestBatch',
      );
      // The handle is `id`, not `job_id`.
      return { jobId: requireString(asRecord(json, 'ingest'), 'id', 'ingest') };
    },

    async search(scope: string, query: string, opts: SearchOpts): Promise<MemoryRow[]> {
      const json = await call(
        {
          method: 'POST',
          path: '/v1/memories/search',
          body: {
            user_id: scope,
            query,
            top_k: opts.topK,
            // Explicit reservation: facts are returned before episodes, so a flat
            // top-k drops every episode (design v0.8 §14).
            episode_slots: opts.episodeSlots,
          },
        },
        'search',
      );
      return parseRows(json);
    },

    async remove(scope: string, memoryId: string): Promise<void> {
      await call(
        {
          method: 'DELETE',
          path: `/v1/memories/${encodeURIComponent(memoryId)}`,
          body: { user_id: scope },
        },
        'remove',
      );
    },

    async jobStatus(jobId: string): Promise<IngestJobStatus> {
      // `/v1/memories/jobs/{id}`, not `/v1/ingest-jobs/{id}` — the latter 404s.
      const json = await call(
        { method: 'GET', path: `/v1/memories/jobs/${encodeURIComponent(jobId)}` },
        'jobStatus',
      );
      const status = asRecord(json, 'jobStatus')['status'];
      // Map the live vocabulary onto the contract's: `running` is still in flight, and
      // `succeeded` is the success the sweeper waits for.
      if (status === TERMINAL_SUCCESS) return 'complete';
      if (status === 'failed') return 'failed';
      if (status === 'pending' || status === 'running') return 'pending';
      return 'unknown';
    },
  };
}
