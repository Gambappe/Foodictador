import { describe, expect, it } from 'vitest';

import { createLogger } from '../config/logger.js';
import { createSettingsClient } from './settings.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function harness(
  respond: (call: Call, attempt: number) => { status: number; body?: string },
) {
  const calls: Call[] = [];
  const lines: string[] = [];
  const sleeps: number[] = [];
  const fetchFn = ((input: URL | RequestInfo, init?: RequestInit) => {
    const call: Call = {
      // The client always passes a URL. Narrowing rather than `String(input)`, which on a
      // bare Request would stringify to "[object Object]" and make a path assertion pass on
      // nothing at all.
      url: input instanceof URL ? input.href : input instanceof Request ? input.url : input,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    const { status, body } = respond(call, calls.length);
    // A 204 may not carry a body at all — `new Response('', {status:204})` throws. Passing
    // null models the real thing, which is what the client's `text === ''` branch handles.
    return Promise.resolve(new Response(status === 204 ? null : (body ?? ''), { status }));
  }) as typeof fetch;

  const client = createSettingsClient({
    url: 'http://relay.invalid',
    token: 'tok',
    logger: createLogger((l) => lines.push(l)),
    fetchFn,
    sleepFn: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  return { client, calls, lines, sleeps };
}

const ok = (value: unknown) => ({
  status: 200,
  body: JSON.stringify({ profile: 'A', key: 'usual', value }),
});

describe('settings client — reads', () => {
  it('GETs the keyed path and returns the value', async () => {
    const h = harness(() => ok({ offLimits: ['shellfish'] }));
    expect(await h.client.get('A', 'usual')).toEqual({ offLimits: ['shellfish'] });
    expect(h.calls[0]?.url).toBe('http://relay.invalid/settings/A/usual');
    expect(h.calls[0]?.method).toBe('GET');
  });

  it('sends the token in a HEADER, because a GET has no body', async () => {
    // Settings are token-gated on read, unlike pool reads — they identify a person (D-8).
    const h = harness(() => ok(null));
    await h.client.get('A', 'usual');
    expect(h.calls[0]?.headers['x-relay-token']).toBe('tok');
    expect(h.calls[0]?.body).toBeNull();
  });

  it('an absent key is null, not a throw', async () => {
    const h = harness(() => ok(null));
    expect(await h.client.get('A', 'usual')).toBeNull();
  });

  it('encodes each path segment, so an id cannot add a path', async () => {
    // `profile = "../reads"` must not reach `DELETE /reads`-adjacent routes, and a slash in a
    // key must not create a fourth segment the relay would reject as an unknown route.
    const h = harness(() => ok(null));
    await h.client.get('../reads', 'a/b');
    expect(h.calls[0]?.url).toBe('http://relay.invalid/settings/..%2Freads/a%2Fb');
  });

  it('does NOT soften a failure into "no settings"', async () => {
    // The D-8 safety property. `usual() === null` means "not provisioned" and X2 refuses on
    // it; an unreachable relay reported as null would silently empty an off-limits list.
    const h = harness(() => ({ status: 500 }));
    await expect(h.client.get('A', 'usual')).rejects.toThrow(/failed with 500/);
    expect(h.calls).toHaveLength(3); // retried, then gave up honestly
  });

  it('rejects a response that is not shaped like a settings response', async () => {
    const h = harness(() => ({ status: 200, body: '["not", "an", "object"]' }));
    await expect(h.client.get('A', 'usual')).rejects.toThrow(/unexpected get response shape/);
  });

  it('rejects invalid JSON rather than treating it as absent', async () => {
    const h = harness(() => ({ status: 200, body: 'not json' }));
    await expect(h.client.get('A', 'usual')).rejects.toThrow(/invalid JSON/);
  });
});

describe('settings client — writes', () => {
  it('PUTs the value with the token in the body', async () => {
    const h = harness(() => ({ status: 204 }));
    await h.client.put('A', 'usual', { offLimits: [] });
    expect(h.calls[0]?.method).toBe('PUT');
    expect(h.calls[0]?.body).toEqual({ token: 'tok', value: { offLimits: [] } });
    expect(h.lines.join('\n')).toContain('wrote usual for profile A');
  });

  it('a 204 with an empty body is a success, not a parse failure', async () => {
    const h = harness(() => ({ status: 204 }));
    await expect(h.client.put('A', 'usual', {})).resolves.toBeUndefined();
  });
});

describe('settings client — transport policy matches M4 deliberately', () => {
  it('retries a 5xx with backoff and succeeds on a later attempt', async () => {
    const h = harness((_call, attempt) =>
      attempt < 3 ? { status: 503 } : ok({ offLimits: ['gluten'] }),
    );
    expect(await h.client.get('A', 'usual')).toEqual({ offLimits: ['gluten'] });
    expect(h.calls).toHaveLength(3);
    expect(h.sleeps).toEqual([200, 400]);
  });

  it('NEVER retries a 4xx — the request itself is wrong and will be wrong again', async () => {
    const h = harness(() => ({ status: 401, body: '{"error":"missing or invalid token"}' }));
    await expect(h.client.get('A', 'usual')).rejects.toThrow(/rejected \(401\)/);
    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });

  it('retries a network fault, not just an HTTP status', async () => {
    let attempts = 0;
    const fetchFn = (() => {
      attempts += 1;
      if (attempts < 2) return Promise.reject(new Error('ECONNREFUSED'));
      return Promise.resolve(new Response(JSON.stringify({ value: 1 }), { status: 200 }));
    }) as typeof fetch;
    const client = createSettingsClient({
      url: 'http://relay.invalid',
      token: 'tok',
      logger: createLogger(() => undefined),
      fetchFn,
      sleepFn: () => Promise.resolve(),
    });
    expect(await client.get('A', 'usual')).toBe(1);
    expect(attempts).toBe(2);
  });
});
