import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { RelayStore } from '../../infra/relay/store.js';
import { createRelayServer } from '../../infra/relay/server.js';
import { createLogger } from '../config/logger.js';
import { sampleRead } from '../contracts/fixtures/index.js';
import type { Read } from '../contracts/types.js';
import { RelayError, createRelayClient } from './relay.js';

const TOKEN = 'test-token';

let clock = Date.parse('2026-07-25T19:00:00.000Z');
let server: Server;
let url: string;
let logLines: string[];

function client(overrides?: { fetchFn?: typeof fetch; token?: string }) {
  return createRelayClient({
    url,
    token: overrides?.token ?? TOKEN,
    logger: createLogger((line) => logLines.push(line)),
    sleepFn: () => Promise.resolve(), // no real backoff waits in tests
    ...(overrides?.fetchFn ? { fetchFn: overrides.fetchFn } : {}),
  });
}

function countingFetch(respond: (call: number) => Response | Error): {
  calls: () => number;
  fetchFn: typeof fetch;
} {
  let calls = 0;
  const fetchFn: typeof fetch = () => {
    calls += 1;
    const result = respond(calls);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  };
  return { calls: () => calls, fetchFn };
}

beforeAll(async () => {
  logLines = [];
  const store = new RelayStore(() => new Date((clock += 1000)));
  server = createRelayServer({ token: TOKEN, store });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe('M4 relay client, against a live P0.4 instance', () => {
  it('round-trips: put → list → setJob visible → drop removes', async () => {
    const relay = client();
    await relay.put(sampleRead);
    let entries = await relay.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.read).toEqual(sampleRead);
    expect(entries[0]?.received_at).toMatch(/^2026-/);
    // Seconds precision, not the open surface's day floor: the client sends the
    // token header on GETs (P0.9/D-12), and the sweeper's settle window computes
    // ageSeconds off this exact field. A day-only stamp here means the header was
    // dropped and every entry looks 0-to-24h old — this is the pin against that.
    expect(entries[0]?.received_at).toMatch(/T\d{2}:\d{2}:\d{2}/);
    expect(entries[0]?.ingest_job_id).toBeUndefined();

    await relay.setJob(sampleRead.read_id, 'job-77');
    entries = await relay.list();
    expect(entries[0]?.ingest_job_id).toBe('job-77');

    await relay.drop(sampleRead.read_id);
    expect(await relay.list()).toHaveLength(0);
  });

  it('drop of an unknown read_id resolves (already gone is success)', async () => {
    await expect(client().drop('never-existed')).resolves.toBeUndefined();
  });

  it('setJob on an unknown read_id surfaces the 404 — the caller decides best-effort', async () => {
    await expect(client().setJob('never-existed', 'job-1')).rejects.toThrow(RelayError);
  });

  it('list(since) filters server-side', async () => {
    const relay = client();
    await relay.put({ ...sampleRead, read_id: '00000000-0000-4000-8000-0000000000a1' });
    const [first] = await relay.list();
    expect(first).toBeDefined();
    await relay.put({ ...sampleRead, read_id: '00000000-0000-4000-8000-0000000000a2' });
    const after = await relay.list(first?.received_at ?? '');
    expect(after).toHaveLength(1);
    expect(after[0]?.read.read_id).toBe('00000000-0000-4000-8000-0000000000a2');
    await relay.reset();
  });

  it('a read with an extra key is rejected client-side with NO request made', async () => {
    const spy = countingFetch(() => new Error('must not be called'));
    const relay = client({ fetchFn: spy.fetchFn });
    const smuggled = { ...sampleRead, received_at: 'nope' } as unknown as Read;
    await expect(relay.put(smuggled)).rejects.toThrow(/unexpected field/);
    expect(spy.calls()).toBe(0);
  });

  it('a bad seed batch names the index and sends nothing', async () => {
    const spy = countingFetch(() => new Error('must not be called'));
    const relay = client({ fetchFn: spy.fetchFn });
    const bad = [sampleRead, { ...sampleRead, weight: 7 }] as Read[];
    await expect(relay.seed(bad)).rejects.toThrow(/reads\[1\]/);
    expect(spy.calls()).toBe(0);
  });

  it('seed round-trips and stats parses', async () => {
    const relay = client();
    const seeded = await relay.seed([
      { ...sampleRead, read_id: '00000000-0000-4000-8000-0000000000b1' },
      { ...sampleRead, read_id: '00000000-0000-4000-8000-0000000000b2' },
    ]);
    expect(seeded).toBe(2);
    const stats = await relay.stats();
    expect(stats.count).toBe(2);
    expect(stats.oldest_entry_age_seconds).toBeGreaterThanOrEqual(0);
    await relay.reset();
    expect((await relay.stats()).count).toBe(0);
  });

  it('a 4xx is never retried: exactly one request, error carries the server message', async () => {
    const spy = countingFetch(
      () => new Response(JSON.stringify({ error: 'missing or invalid token' }), { status: 401 }),
    );
    const relay = client({ fetchFn: spy.fetchFn });
    await expect(relay.put(sampleRead)).rejects.toThrow(/401.*missing or invalid token/);
    expect(spy.calls()).toBe(1);
  });

  it('a 4xx with a non-JSON body (proxy error page) is still not retried', async () => {
    const spy = countingFetch(() => new Response('<html>Bad Request</html>', { status: 400 }));
    const relay = client({ fetchFn: spy.fetchFn });
    await expect(relay.stats()).rejects.toThrow(/invalid JSON \(400\)/);
    expect(spy.calls()).toBe(1);
  });

  it('5xx and network errors retry with backoff, then succeed', async () => {
    const spy = countingFetch((call) => {
      if (call === 1) return new Response('', { status: 503 });
      if (call === 2) return new Error('socket hang up');
      return new Response(JSON.stringify({ count: 0, oldest_entry_age_seconds: 0 }), { status: 200 });
    });
    const relay = client({ fetchFn: spy.fetchFn });
    expect(await relay.stats()).toEqual({ count: 0, oldest_entry_age_seconds: 0 });
    expect(spy.calls()).toBe(3);
  });

  it('gives up after three attempts and throws the last error', async () => {
    const spy = countingFetch(() => new Response('', { status: 500 }));
    const relay = client({ fetchFn: spy.fetchFn });
    await expect(relay.stats()).rejects.toThrow(/500/);
    expect(spy.calls()).toBe(3);
  });

  it('malformed list entries are skipped with a logged line, valid ones survive', async () => {
    const spy = countingFetch(
      () =>
        new Response(
          JSON.stringify([
            { read: sampleRead, received_at: '2026-07-25T19:00:00.000Z' },
            { read: { not: 'a read' }, received_at: '2026-07-25T19:00:00.000Z' },
            { read: sampleRead }, // missing received_at
          ]),
          { status: 200 },
        ),
    );
    logLines = [];
    const relay = client({ fetchFn: spy.fetchFn });
    const entries = await relay.list();
    expect(entries).toHaveLength(1);
    expect(logLines.filter((l) => l.includes('skipping malformed entry'))).toHaveLength(2);
  });
});

describe('M4 the ingest ledger survives the boundary parse (M10)', () => {
  it('carries pool_memories inward', async () => {
    // Caught live, not by a test. `parseEntry` builds a FRESH entry rather than spreading the
    // wire object — correct, because unknown fields must not travel inward — and the cost is
    // that a NEW field is invisible until it is named there. It was: the handles were on the
    // entry, `curl` showed them, the sweep reported recording them, and `forget` still said
    // `no pool handles recorded`. Nothing was broken except the parse.
    const relay = createRelayClient({
      url: 'http://relay.test',
      token: 't',
      logger: createLogger(() => undefined),
      fetchFn: () =>
        Promise.resolve(
          new Response(
            JSON.stringify([
              {
                read: sampleRead,
                received_at: '2026-07-25T19:00:00.000Z',
                ingest_job_id: 'job-1',
                pool_memories: ['mem-a', 'mem-b'],
              },
            ]),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
    });
    const entries = await relay.list();
    expect(entries[0]?.pool_memories).toEqual(['mem-a', 'mem-b']);
  });

  it('a malformed ledger is dropped, not carried inward as junk', async () => {
    const relay = createRelayClient({
      url: 'http://relay.test',
      token: 't',
      logger: createLogger(() => undefined),
      fetchFn: () =>
        Promise.resolve(
          new Response(
            JSON.stringify([
              {
                read: sampleRead,
                received_at: '2026-07-25T19:00:00.000Z',
                pool_memories: [42, '', null],
              },
            ]),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
    });
    const entries = await relay.list();
    expect(entries[0]?.pool_memories).toBeUndefined();
  });
});
