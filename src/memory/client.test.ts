import { describe, expect, it } from 'vitest';

import {
  createMemoryClient,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from './client.js';

function recordingTransport(respond: (req: HttpRequest) => { status: number; json: unknown }) {
  const requests: HttpRequest[] = [];
  const transport: HttpTransport = {
    request(req) {
      requests.push(req);
      return Promise.resolve(respond(req));
    },
  };
  return { requests, transport };
}

/**
 * Responses in the shapes the LIVE API actually returns, confirmed against
 * api.production.xtrace.ai — see README's D-2 table.
 *
 * The previous version of this fixture returned the shapes this file had *guessed*:
 * `{job_id}`, `{rows: [{memory_id, kind, content}]}`, `/v1/memories/jobs/{id}`, and a
 * terminal status of `complete`. Every one of those is wrong, so all six tests below
 * passed against a client that could not talk to the substrate at all. A mock is a claim
 * about someone else's API, and an unverified mock makes a test suite an echo.
 */
const okResponses = (req: HttpRequest): { status: number; json: unknown } => {
  if (req.path === '/v1/memories') {
    return { status: 202, json: { object: 'ingest_job', id: 'job-1', status: 'pending' } };
  }
  if (req.path === '/v1/memories/search') {
    return {
      status: 200,
      json: {
        object: 'search',
        mode: 'compose',
        data: [
          { id: 'm1', object: 'memory', type: 'fact', text: 'prefers the counter seat' },
          { id: 'm2', object: 'memory', type: 'episode', text: 'the birthday dinner arc' },
          { id: 'm3', object: 'memory', type: 'mystery', text: 'skipped, not fatal' },
        ],
        context: '',
      },
    };
  }
  if (req.path.startsWith('/v1/memories/jobs/')) {
    return { status: 200, json: { object: 'ingest_job', id: 'job-1', status: 'succeeded' } };
  }
  return { status: 204, json: null };
};

describe('M1 MemoryClient', () => {
  it('every request carries user_id (the always-pass-scope rule)', async () => {
    const { requests, transport } = recordingTransport(okResponses);
    const client = createMemoryClient(transport);
    await client.ingest('profile-a', 'raw prose, unmodified');
    await client.search('profile-a', 'counter', { topK: 8, episodeSlots: 2 });
    await client.remove('profile-a', 'm1');
    for (const req of requests) {
      expect(req.body?.['user_id'], `${req.method} ${req.path}`).toBe('profile-a');
    }
  });

  it('search carries an explicit episode-slot reservation', async () => {
    const { requests, transport } = recordingTransport(okResponses);
    await createMemoryClient(transport).search('confit:pool', 'q', { topK: 40, episodeSlots: 3 });
    const search = requests.find((r) => r.path === '/v1/memories/search');
    expect(search?.body?.['episode_slots']).toBe(3);
    expect(search?.body?.['top_k']).toBe(40);
  });

  it('no overload permits omitting the scope (compile-time only)', () => {
    // The mistyped calls live in a function that is deliberately NEVER invoked:
    // `npm run typecheck` still checks the body, so each @ts-expect-error fails the
    // build if an overload ever permits omitting the scope — but nothing executes.
    // (Invoking them was the M1 defect: @ts-expect-error suppresses the compile
    // error yet the call still runs, and search exploded on `opts.topK` as an
    // unhandled rejection.)
    const compileTimeOnly = (client: ReturnType<typeof createMemoryClient>): void => {
      // @ts-expect-error — ingest requires (scope, payload)
      void client.ingest('just-a-payload');
      // @ts-expect-error — search requires (scope, query, opts)
      void client.search('query-without-scope', { topK: 5, episodeSlots: 1 });
      // @ts-expect-error — remove requires (scope, memoryId)
      void client.remove('memory-id-without-scope');
    };
    expect(compileTimeOnly).toBeInstanceOf(Function); // declared, never called
  });

  it('ingest returns the pollable handle and jobStatus maps the states', async () => {
    const { transport } = recordingTransport(okResponses);
    const client = createMemoryClient(transport);
    const handle = await client.ingest('profile-a', 'text');
    expect(handle).toEqual({ jobId: 'job-1' });
    expect(await client.jobStatus('job-1')).toBe('complete');

    const weird = recordingTransport(() => ({ status: 200, json: { status: 'exploded' } }));
    expect(await createMemoryClient(weird.transport).jobStatus('job-9')).toBe('unknown');
  });

  it('search parses rows, keeps episode kinds, and skips unknown kinds', async () => {
    const { transport } = recordingTransport(okResponses);
    const rows = await createMemoryClient(transport).search('p', 'q', { topK: 5, episodeSlots: 1 });
    expect(rows).toEqual([
      { memoryId: 'm1', kind: 'fact', content: 'prefers the counter seat' },
      { memoryId: 'm2', kind: 'episode', content: 'the birthday dinner arc' },
    ]);
  });

  it('memory ids are URL-encoded on remove and job ids on poll', async () => {
    const { requests, transport } = recordingTransport(okResponses);
    const client = createMemoryClient(transport);
    await client.remove('p', 'mem/with slash');
    await client.jobStatus('job with space');
    expect(requests[0]?.path).toBe('/v1/memories/mem%2Fwith%20slash');
    expect(requests[1]?.path).toBe('/v1/memories/jobs/job%20with%20space');
  });

  it('non-2xx and malformed responses throw with context, never silently', async () => {
    const failing = recordingTransport(() => ({ status: 503, json: null }));
    await expect(createMemoryClient(failing.transport).ingest('p', 'x')).rejects.toThrow(
      /ingest failed with status 503/,
    );
    const malformed = recordingTransport(() => ({ status: 200, json: { nope: true } }));
    await expect(createMemoryClient(malformed.transport).ingest('p', 'x')).rejects.toThrow(
      /missing "id"/,
    );
    const badRows = recordingTransport(() => ({ status: 200, json: { rows: 'not-an-array' } }));
    await expect(
      createMemoryClient(badRows.transport).search('p', 'q', { topK: 1, episodeSlots: 1 }),
    ).rejects.toThrow(/missing "data"/);
  });
});

/**
 * SL-58 — the client had no retry, and `confit sweep` found it.
 *
 * The sweeper polls `jobStatus` once per settled entry. After a seed that is 221 calls in a
 * burst, and the first `429` threw straight out of the pass: `internal error`, exit 3, nothing
 * confirmed and no ledger recorded — for the 220 healthy entries as much as the rate-limited
 * one. A rate limit is the substrate saying "later", not "no".
 *
 * Red-verified: setting MAX_ATTEMPTS to 1 reds the first two; ignoring `Retry-After` reds the
 * third; retrying 4xx reds the fourth.
 */
describe('M1 transient failures are retried, permanent ones are not', () => {
  function transportWith(statuses: number[], headers: Array<number | undefined> = []) {
    const seen: number[] = [];
    let i = 0;
    const transport: HttpTransport = {
      request: () => {
        const status = statuses[Math.min(i, statuses.length - 1)] ?? 200;
        seen.push(status);
        const res: HttpResponse = { status, json: status < 300 ? { status: 'succeeded' } : null };
        const advised = headers[i];
        if (advised !== undefined) res.retryAfterSeconds = advised;
        i += 1;
        return Promise.resolve(res);
      },
    };
    return { transport, seen };
  }

  const noSleep = { sleepFn: () => Promise.resolve() };

  it('a 429 is retried and the call succeeds', async () => {
    const t = transportWith([429, 429, 200]);
    const client = createMemoryClient(t.transport, noSleep);
    await expect(client.jobStatus('job-1')).resolves.toBe('complete');
    expect(t.seen).toEqual([429, 429, 200]);
  });

  it('a 5xx is retried too', async () => {
    const t = transportWith([503, 200]);
    const client = createMemoryClient(t.transport, noSleep);
    await expect(client.jobStatus('job-1')).resolves.toBe('complete');
    expect(t.seen).toEqual([503, 200]);
  });

  it('Retry-After is honoured rather than guessed over', async () => {
    // Guessing a backoff against a server that has told you the number is how a rate limit
    // becomes a slower rate limit.
    const waits: number[] = [];
    const t = transportWith([429, 200], [2, undefined]);
    const client = createMemoryClient(t.transport, {
      sleepFn: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    await client.jobStatus('job-1');
    expect(waits).toEqual([2000]);
  });

  it('a 4xx is NEVER retried — the request is wrong and will be wrong again', async () => {
    const t = transportWith([422]);
    const client = createMemoryClient(t.transport, noSleep);
    await expect(client.jobStatus('job-1')).rejects.toThrow(/422/);
    expect(t.seen).toEqual([422]); // exactly one attempt
  });

  it('gives up after a bounded number of attempts rather than hanging on', async () => {
    const t = transportWith([429]);
    const client = createMemoryClient(t.transport, noSleep);
    await expect(client.jobStatus('job-1')).rejects.toThrow(/429/);
    expect(t.seen.length).toBeGreaterThan(1);
    expect(t.seen.length).toBeLessThanOrEqual(6);
  });
});
