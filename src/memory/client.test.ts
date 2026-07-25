import { describe, expect, it } from 'vitest';

import { createMemoryClient, type HttpRequest, type HttpTransport } from './client.js';

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

const okResponses = (req: HttpRequest): { status: number; json: unknown } => {
  if (req.path === '/v1/memories') return { status: 200, json: { job_id: 'job-1' } };
  if (req.path === '/v1/memories/search') {
    return {
      status: 200,
      json: {
        rows: [
          { memory_id: 'm1', kind: 'fact', content: 'prefers the counter seat' },
          { memory_id: 'm2', kind: 'episode', content: 'the birthday dinner arc' },
          { memory_id: 'm3', kind: 'mystery', content: 'skipped, not fatal' },
        ],
      },
    };
  }
  if (req.path.startsWith('/v1/ingest-jobs/')) return { status: 200, json: { status: 'complete' } };
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

  it('no overload permits omitting the scope', () => {
    const { transport } = recordingTransport(okResponses);
    const client = createMemoryClient(transport);
    // @ts-expect-error — ingest requires (scope, payload)
    void client.ingest('just-a-payload');
    // @ts-expect-error — search requires (scope, query, opts)
    void client.search('query-without-scope', { topK: 5, episodeSlots: 1 });
    // @ts-expect-error — remove requires (scope, memoryId)
    void client.remove('memory-id-without-scope');
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
    expect(requests[1]?.path).toBe('/v1/ingest-jobs/job%20with%20space');
  });

  it('non-2xx and malformed responses throw with context, never silently', async () => {
    const failing = recordingTransport(() => ({ status: 503, json: null }));
    await expect(createMemoryClient(failing.transport).ingest('p', 'x')).rejects.toThrow(
      /ingest failed with status 503/,
    );
    const malformed = recordingTransport(() => ({ status: 200, json: { nope: true } }));
    await expect(createMemoryClient(malformed.transport).ingest('p', 'x')).rejects.toThrow(
      /missing "job_id"/,
    );
    const badRows = recordingTransport(() => ({ status: 200, json: { rows: 'not-an-array' } }));
    await expect(
      createMemoryClient(badRows.transport).search('p', 'q', { topK: 1, episodeSlots: 1 }),
    ).rejects.toThrow(/missing "rows"/);
  });
});
