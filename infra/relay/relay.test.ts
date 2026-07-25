import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { sampleRead } from '../../src/contracts/fixtures/index.js';
import { RelayStore } from './store.js';
import { createRelayServer, validateRead } from './server.js';

const TOKEN = 'test-token';

let clock = Date.parse('2026-07-25T19:00:00.000Z');
let server: Server;
let base: string;

function http(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  return fetch(`${base}${path}`, init).then(async (res) => {
    const text = await res.text();
    return { status: res.status, json: text === '' ? null : (JSON.parse(text) as unknown) };
  });
}

beforeAll(async () => {
  const store = new RelayStore(() => new Date((clock += 1000)));
  server = createRelayServer({ token: TOKEN, store });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe('P0.4 relay service', () => {
  it('valid read → 201, server assigns received_at', async () => {
    const res = await http('POST', '/reads', { token: TOKEN, read: sampleRead });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ read_id: sampleRead.read_id });
    expect((res.json as { received_at: string }).received_at).toMatch(/^2026-/);
  });

  it('a seventh key → 400; received_at or ingest_job_id in the body → 400', async () => {
    const seventh = await http('POST', '/reads', {
      token: TOKEN,
      read: { ...sampleRead, mood: 'sneaky' },
    });
    expect(seventh.status).toBe(400);
    expect((seventh.json as { error: string }).error).toMatch(/unexpected field\(s\): mood/);

    for (const key of ['received_at', 'ingest_job_id']) {
      const smuggled = await http('POST', '/reads', {
        token: TOKEN,
        read: { ...sampleRead, [key]: 'nope' },
      });
      expect(smuggled.status, key).toBe(400);
      expect((smuggled.json as { error: string }).error).toContain(key);
    }
  });

  it('bad enum and bad weight → 400 naming the field', async () => {
    const badDriver = await http('POST', '/reads', {
      token: TOKEN,
      read: { ...sampleRead, driver: 'spice_maximalist' },
    });
    expect(badDriver.status).toBe(400);
    expect((badDriver.json as { error: string }).error).toMatch(/read\.driver/);

    const badWeight = await http('POST', '/reads', {
      token: TOKEN,
      read: { ...sampleRead, weight: 1.5 },
    });
    expect(badWeight.status).toBe(400);
    expect((badWeight.json as { error: string }).error).toMatch(/read\.weight/);
  });

  it('missing or wrong token on any mutation → 401; reads stay open', async () => {
    expect((await http('POST', '/reads', { read: sampleRead })).status).toBe(401);
    expect((await http('POST', '/seed', { token: 'wrong', reads: [] })).status).toBe(401);
    expect((await http('POST', '/reset', {})).status).toBe(401);
    expect((await http('DELETE', `/reads/${sampleRead.read_id}`, {})).status).toBe(401);
    expect((await http('GET', '/reads')).status).toBe(200);
    expect((await http('GET', '/stats')).status).toBe(200);
  });

  it('setJob round-trips into list; unknown read_id → 404', async () => {
    const annotate = await http('POST', `/reads/${sampleRead.read_id}/ingest-job`, {
      token: TOKEN,
      ingest_job_id: 'job-42',
    });
    expect(annotate.status).toBe(204);
    const listed = (await http('GET', '/reads')).json as Array<{
      read: { read_id: string };
      ingest_job_id?: string;
    }>;
    expect(listed.find((e) => e.read.read_id === sampleRead.read_id)?.ingest_job_id).toBe('job-42');

    const unknown = await http('POST', '/reads/no-such-read/ingest-job', {
      token: TOKEN,
      ingest_job_id: 'job-1',
    });
    expect(unknown.status).toBe(404);

    const emptyJob = await http('POST', `/reads/${sampleRead.read_id}/ingest-job`, {
      token: TOKEN,
      ingest_job_id: '',
    });
    expect(emptyJob.status).toBe(400);
  });

  it('re-putting the same read_id preserves received_at and ingest_job_id', async () => {
    const before = (await http('GET', '/reads')).json as Array<{
      read: { read_id: string; weight: number };
      received_at: string;
      ingest_job_id?: string;
    }>;
    const entry = before.find((e) => e.read.read_id === sampleRead.read_id);
    const res = await http('POST', '/reads', {
      token: TOKEN,
      read: { ...sampleRead, weight: 0.5 },
    });
    expect(res.status).toBe(201);
    const after = (await http('GET', '/reads')).json as typeof before;
    const updated = after.find((e) => e.read.read_id === sampleRead.read_id);
    expect(updated?.read.weight).toBe(0.5);
    expect(updated?.received_at).toBe(entry?.received_at);
    expect(updated?.ingest_job_id).toBe('job-42');
  });

  it('oldest_entry_age_seconds grows as the clock advances past a stale entry', async () => {
    const first = (await http('GET', '/stats')).json as { oldest_entry_age_seconds: number };
    clock += 30_000; // 30 fake seconds pass
    const second = (await http('GET', '/stats')).json as { oldest_entry_age_seconds: number };
    expect(second.oldest_entry_age_seconds).toBeGreaterThan(first.oldest_entry_age_seconds);
  });

  it('since= filters, DELETE removes (404 when unknown), seed and reset round-trip', async () => {
    const all = (await http('GET', '/reads')).json as Array<{ received_at: string }>;
    const latest = all.map((e) => e.received_at).sort().at(-1) ?? '';
    expect(((await http('GET', `/reads?since=${encodeURIComponent(latest)}`)).json as unknown[]).length).toBe(0);

    expect((await http('DELETE', `/reads/${sampleRead.read_id}`, { token: TOKEN })).status).toBe(204);
    expect((await http('DELETE', `/reads/${sampleRead.read_id}`, { token: TOKEN })).status).toBe(404);

    const seed = await http('POST', '/seed', {
      token: TOKEN,
      reads: [sampleRead, { ...sampleRead, read_id: '00000000-0000-4000-8000-0000000000ee' }],
    });
    expect(seed.json).toEqual({ count: 2 });

    const badSeed = await http('POST', '/seed', {
      token: TOKEN,
      reads: [{ ...sampleRead, driver: 'nope' }],
    });
    expect(badSeed.status).toBe(400);
    expect((badSeed.json as { error: string }).error).toMatch(/reads\[0\]/);

    expect((await http('POST', '/reset', { token: TOKEN })).json).toEqual({ count: 0 });
    expect(((await http('GET', '/reads')).json as unknown[]).length).toBe(0);
  });

  it('invalid JSON → 400; unknown route → 404', async () => {
    const res = await fetch(`${base}/reads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    expect((await http('GET', '/nope')).status).toBe(404);
    expect((await http('POST', '/reads/extra/deep/route', { token: TOKEN })).status).toBe(404);
  });
});

describe('store dump/restore', () => {
  it('serialize → restore round-trips entries including metadata', () => {
    const store = new RelayStore(() => new Date('2026-07-25T19:00:00Z'));
    store.put(sampleRead);
    store.setJob(sampleRead.read_id, 'job-7');
    const copy = new RelayStore();
    const report = copy.restore(store.serialize());
    expect(report).toEqual({ restored: 1, skipped: 0 });
    const entries = copy.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.ingest_job_id).toBe('job-7');
    expect(entries[0]?.read).toEqual(sampleRead);
  });

  it('restore skips structurally invalid entries instead of loading garbage', () => {
    const store = new RelayStore();
    const report = store.restore(
      JSON.stringify({
        entries: [
          { read: sampleRead, received_at: '2026-07-25T19:00:00.000Z' },
          { read: { no_id: true }, received_at: '2026-07-25T19:00:00.000Z' },
          { received_at: '2026-07-25T19:00:00.000Z' },
          null,
          { read: sampleRead }, // missing received_at
        ],
      }),
    );
    expect(report).toEqual({ restored: 1, skipped: 4 });
    expect(store.list()).toHaveLength(1);
  });
});

describe('validateRead unit surface', () => {
  it('accepts the sample and rejects a non-object', () => {
    expect(validateRead(sampleRead).ok).toBe(true);
    expect(validateRead(null).ok).toBe(false);
    expect(validateRead([sampleRead]).ok).toBe(false);
  });
});
