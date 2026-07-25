/**
 * The shared relay (P0.4) — design v0.8 §6 routes plus D-1's job-annotation route.
 *
 * Write token on every mutation; reads open. POST /reads validates the body against
 * READ_KEYS exactly and rejects anything else with 400 — extra keys included, which
 * makes smuggled `received_at`/`ingest_job_id` a 400 by construction: those are
 * server-side metadata, never part of the read body.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { Read } from '../../src/contracts/types.js';
import { parseRead } from '../../src/kernel/read.js';
import type { RelayStore } from './store.js';

const BODY_LIMIT_BYTES = 1_000_000;

/**
 * The route validator. Was a 32-line reimplementation of `parseRead` (SL-07)
 * that had already started to diverge in its error text — reject-by-construction
 * with two constructions is one refactor from being reject-by-one-construction.
 * This is a thin adapter over the single boundary parser (K1) instead.
 */
export function validateRead(value: unknown): { ok: true; read: Read } | { ok: false; error: string } {
  try {
    return { ok: true, read: parseRead(value) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text === '') {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, payload?: unknown): void {
  if (payload === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
}

export interface RelayServerOptions {
  token: string;
  store: RelayStore;
}

export function createRelayServer(options: RelayServerOptions): Server {
  const { token, store } = options;

  return createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : 'internal error';
      const status = message === 'body too large' || message === 'body is not valid JSON' ? 400 : 500;
      if (!res.headersSent) send(res, status, { error: message });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://relay.local');
    const method = req.method ?? 'GET';
    const segments = url.pathname.split('/').filter((s) => s !== '');

    // ---- reads: open to read, precise only with the token (P0.9 / D-12) ----
    //
    // D-7 made the relay hold every read for ever, which turned [E26]'s accepted
    // minutes-wide window into a permanent archive: an open GET serving precise
    // `received_at` in arrival order let anyone reconstruct who-confessed-when long
    // after the fact. The open view still discloses WHAT the pool holds — the six
    // identity-free fields, P0.4's transparency posture — but not WHEN beyond the
    // day, not in an order that encodes arrival (read_id sort, arrival-independent),
    // and without the operational metadata (`ingest_job_id`, `pool_memories`) that
    // no public reader has a use for. Clients holding the token (M4 sends it on
    // every request, M11's `x-relay-token` header convention) get exactly the old
    // view — precise, arrival-ordered, since-filterable — so the sweeper's settle
    // window and the counting path are unchanged.
    //
    // A live poller can still diff snapshots to observe new arrivals; that is the
    // [E26] slice risk the design discloses, and it needs no timestamp to work.
    // What this closes is the HISTORY: yesterday's ordering is not reconstructible
    // from the open surface today.
    if (method === 'GET' && url.pathname === '/reads') {
      if (req.headers['x-relay-token'] === token) {
        send(res, 200, store.list(url.searchParams.get('since') ?? undefined));
        return;
      }
      if (url.searchParams.has('since')) {
        // `since` is an ordering query: answering it openly hands back exactly the
        // arrival sequence the coarse view exists to withhold.
        send(res, 401, {
          error: 'since requires the token — arrival order is not served openly ([E26]/P0.9)',
        });
        return;
      }
      const coarse = store
        .list()
        .map((entry) => ({ read: entry.read, received_at: entry.received_at.slice(0, 10) }))
        .sort((a, b) =>
          a.read.read_id < b.read.read_id ? -1 : a.read.read_id > b.read.read_id ? 1 : 0,
        );
      send(res, 200, coarse);
      return;
    }
    if (method === 'GET' && url.pathname === '/stats') {
      const stats = store.stats();
      if (req.headers['x-relay-token'] === token) {
        send(res, 200, stats);
        return;
      }
      // The count is the pool size and stays exact; the age is time information and
      // follows the same day rule as `received_at` ([E26]/P0.9).
      send(res, 200, {
        count: stats.count,
        oldest_entry_age_seconds: Math.floor(stats.oldest_entry_age_seconds / 86400) * 86400,
      });
      return;
    }

    // ---- settings: token required on READS too ----
    //
    // Deliberately unlike `/reads`, which P0.4 left open because a pool read carries no
    // account linkage ([E26]). Settings do: they are one named profile's allergies and
    // intolerances (D-8). An open GET here would publish them to anyone who can reach the
    // relay — a different and much worse thing than the arrival-ordering side channel P0.9
    // tracks.
    //
    // KNOWN LIMITATION, stated rather than left to be discovered: the relay has ONE token,
    // so any client holding it can read ANY profile's settings. Acceptable for a two-profile
    // demo operated by one person; NOT acceptable for real multi-user use, which needs
    // per-profile credentials first. Nothing here pretends otherwise.
    if (segments.length === 3 && segments[0] === 'settings') {
      const profile = decodeURIComponent(segments[1] ?? '');
      const key = decodeURIComponent(segments[2] ?? '');
      if (profile === '' || key === '') {
        send(res, 400, { error: 'settings path needs a profile and a key' });
        return;
      }
      if (method === 'GET') {
        // Header, not body: clients do not send a GET body, and requiring one would make
        // this unreachable from curl and from M4's client alike.
        if (req.headers['x-relay-token'] !== token) {
          send(res, 401, { error: 'missing or invalid token' });
          return;
        }
        send(res, 200, { profile, key, value: store.settingsGet(profile, key) });
        return;
      }
      if (method === 'PUT') {
        const settingsBody = (await readBody(req)) as Record<string, unknown>;
        if (settingsBody['token'] !== token) {
          send(res, 401, { error: 'missing or invalid token' });
          return;
        }
        if (!('value' in settingsBody)) {
          send(res, 400, { error: 'settings PUT needs a "value"' });
          return;
        }
        // No schema check here on purpose. The relay is a store; the boundary parser lives
        // in M3 (`parseUsualProfile`), which is where a malformed profile must be caught so
        // one implementation owns the rule. A validator here would be a second, drifting copy.
        store.settingsPut(profile, key, settingsBody['value']);
        send(res, 204);
        return;
      }
      send(res, 405, { error: `settings supports GET and PUT, not ${method}` });
      return;
    }

    // ---- mutations: token required ----
    const isMutation =
      (method === 'POST' && ['/reads', '/seed', '/reset'].includes(url.pathname)) ||
      (method === 'POST' &&
        segments.length === 3 &&
        segments[0] === 'reads' &&
        (segments[2] === 'ingest-job' || segments[2] === 'memories')) ||
      (method === 'DELETE' && segments.length === 2 && segments[0] === 'reads');
    if (!isMutation) {
      send(res, 404, { error: `no route for ${method} ${url.pathname}` });
      return;
    }

    const body = (await readBody(req)) as Record<string, unknown>;
    if (body['token'] !== token) {
      send(res, 401, { error: 'missing or invalid token' });
      return;
    }

    if (method === 'POST' && url.pathname === '/reads') {
      const verdict = validateRead(body['read']);
      if (!verdict.ok) {
        send(res, 400, { error: verdict.error });
        return;
      }
      const entry = store.put(verdict.read);
      send(res, 201, { read_id: entry.read.read_id, received_at: entry.received_at });
      return;
    }

    if (method === 'POST' && segments.length === 3 && segments[0] === 'reads' && segments[2] === 'memories') {
      const readId = decodeURIComponent(segments[1] ?? '');
      const ids = body['pool_memories'];
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || id === '')) {
        send(res, 400, { error: 'pool_memories must be an array of non-empty strings' });
        return;
      }
      if (!store.setPoolMemories(readId, ids as string[])) {
        send(res, 404, { error: `no relay entry for read_id ${readId}` });
        return;
      }
      send(res, 204);
      return;
    }

    if (method === 'POST' && segments.length === 3 && segments[0] === 'reads' && segments[2] === 'ingest-job') {
      const readId = decodeURIComponent(segments[1] ?? '');
      const jobId = body['ingest_job_id'];
      if (typeof jobId !== 'string' || jobId === '') {
        send(res, 400, { error: 'ingest_job_id must be a non-empty string' });
        return;
      }
      if (!store.setJob(readId, jobId)) {
        send(res, 404, { error: `no relay entry for read_id ${readId}` });
        return;
      }
      send(res, 204);
      return;
    }

    if (method === 'DELETE') {
      const readId = decodeURIComponent(segments[1] ?? '');
      if (!store.drop(readId)) {
        send(res, 404, { error: `no relay entry for read_id ${readId}` });
        return;
      }
      send(res, 204);
      return;
    }

    if (method === 'POST' && url.pathname === '/seed') {
      const reads = body['reads'];
      if (!Array.isArray(reads)) {
        send(res, 400, { error: 'seed body needs a "reads" array' });
        return;
      }
      const validated: Read[] = [];
      for (const [index, raw] of reads.entries()) {
        const verdict = validateRead(raw);
        if (!verdict.ok) {
          send(res, 400, { error: `reads[${index}]: ${verdict.error}` });
          return;
        }
        validated.push(verdict.read);
      }
      send(res, 200, { count: store.seed(validated) });
      return;
    }

    // POST /reset
    store.reset();
    send(res, 200, { count: 0 });
  }
}
