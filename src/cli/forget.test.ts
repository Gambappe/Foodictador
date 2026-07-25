import { describe, expect, it } from 'vitest';

import { DEFAULT_FLAGS } from '../contracts/flags.js';
import { createFlagStore, createLogger } from '../config/index.js';
import type { AppConfig } from '../config/index.js';
import type { ForgetReport } from '../memory/forget.js';
import { fixtureGraph } from '../config/wiring.js';
import { parseArgv } from './args.js';
import { createForgetCommand } from './forget.js';
import type { CommandContext } from './main.js';
import { EXIT } from './render.js';

const CONFIG: AppConfig = {
  xtraceBaseUrl: 'http://localhost:1',
  xtraceApiKey: 'k',
  relayUrl: 'http://localhost:2',
  relayToken: 't',
  anthropicApiKey: null,
  settleWindowSeconds: 480,
  proseBufferPath: '/tmp/confit-test-prose.json',
};

function context(readId: string): CommandContext {
  const logger = createLogger(() => {});
  return {
    argv: parseArgv(['forget', readId]),
    config: CONFIG,
    flags: createFlagStore({ ...DEFAULT_FLAGS }, logger),
    logger,
    // Only present to satisfy CommandContext — this suite injects its own forget fn.
    // Fixture stores, because a live graph would build clients against invalid hosts.
    graph: fixtureGraph({ logger }),
  };
}

function report(overrides: Partial<ForgetReport> = {}): ForgetReport {
  return {
    read_id: 'b7f1c4e2-3a9d-4c58-8e11-2f6d0a5c9b34',
    pool: { status: 'deleted', count: 2 },
    relay: { status: 'deleted', count: 1 },
    user: { status: 'skipped', detail: 'no user-scope handles for this read' },
    buffer: { status: 'nothing_to_delete' },
    ok: true,
    ...overrides,
  };
}

describe('X5 confit forget', () => {
  it('reports all three targets, but a skipped user target is not success (SL-19)', async () => {
    // The default fixture has pool and relay deleted and user skipped — the exact
    // shape SL-19 reproduced. A skipped target means M8 never even attempted the
    // user-scope delete, so this is not "Deleted from Confit"; it is partial, and
    // exits 1 (an expected failure) rather than 0.
    const handler = createForgetCommand(() => Promise.resolve(report()));
    const result = await handler(context('b7f1c4e2-3a9d-4c58-8e11-2f6d0a5c9b34'));
    expect(result.exit).toBe(EXIT.expectedFailure);
    expect(result.lines[0]).toContain('Partly deleted from Confit');
    expect(result.lines[0]).not.toContain('Deleted from Confit:');
    expect(result.lines.some((l) => l.startsWith('  pool:') && l.includes('deleted (2 records)'))).toBe(true);
    expect(result.lines.some((l) => l.startsWith('  relay:') && l.includes('deleted'))).toBe(true);
    expect(result.lines.some((l) => l.startsWith('  user:') && l.includes('skipped'))).toBe(true);
    expect(result.data['read_id']).toBe('b7f1c4e2-3a9d-4c58-8e11-2f6d0a5c9b34');
  });

  it('exits 0 with "Deleted from Confit" only once every target is resolved', async () => {
    const handler = createForgetCommand(() =>
      Promise.resolve(
        report({ user: { status: 'deleted', count: 1 } }),
      ),
    );
    const result = await handler(context('b7f1c4e2-3a9d-4c58-8e11-2f6d0a5c9b34'));
    expect(result.exit ?? EXIT.ok).toBe(EXIT.ok);
    expect(result.lines[0]).toBe('Deleted from Confit: b7f1c4e2-3a9d-4c58-8e11-2f6d0a5c9b34');
  });

  it('a partial failure exits 1 and names the target that failed', async () => {
    const handler = createForgetCommand(() =>
      Promise.resolve(
        report({
          relay: { status: 'failed', detail: 'relay: 503 after 3 attempts' },
          ok: false,
        }),
      ),
    );
    const result = await handler(context('some-read'));
    expect(result.exit).toBe(EXIT.expectedFailure);
    expect(result.lines[0]).toContain('relay failed');
    expect(result.lines.some((l) => l.startsWith('  relay:') && l.includes('FAILED'))).toBe(true);
  });

  it('an unknown read_id exits 0 with the already-gone register when every target resolved', async () => {
    const handler = createForgetCommand(() =>
      Promise.resolve(
        report({
          pool: { status: 'nothing_to_delete' },
          relay: { status: 'nothing_to_delete' },
          user: { status: 'nothing_to_delete' },
        }),
      ),
    );
    const result = await handler(context('never-existed'));
    expect(result.exit ?? EXIT.ok).toBe(EXIT.ok);
    expect(result.lines[0]).toContain('already gone from Confit');
  });

  it('an unknown read_id with a still-skipped user target reports partial, not "already gone"', async () => {
    // Pool and relay found nothing, but the user target was never attempted — Confit
    // cannot claim the confession side is "already gone" when it never checked.
    const handler = createForgetCommand(() =>
      Promise.resolve(
        report({
          pool: { status: 'nothing_to_delete' },
          relay: { status: 'nothing_to_delete' },
          user: { status: 'skipped', detail: 'no user-scope handles for this read' },
        }),
      ),
    );
    const result = await handler(context('never-existed'));
    expect(result.exit).toBe(EXIT.expectedFailure);
    expect(result.lines[0]).toContain('Partly deleted from Confit');
  });

  it('passes the positional read_id through to the backend', async () => {
    const seen: string[] = [];
    const handler = createForgetCommand((readId) => {
      seen.push(readId);
      return Promise.resolve(report());
    });
    await handler(context('the-exact-id'));
    expect(seen).toEqual(['the-exact-id']);
  });

  it('the copy stays in the app-mediated register — no cryptographic implication', async () => {
    const handler = createForgetCommand(() => Promise.resolve(report()));
    const result = await handler(context('x'));
    const text = result.lines.join(' ').toLowerCase();
    expect(text).toContain('deleted from confit');
    for (const banned of ['crypto', 'encrypt', 'tombstone', 'provable', 'unrecoverable']) {
      expect(text).not.toContain(banned);
    }
  });

  it('both failing targets are named together', async () => {
    const handler = createForgetCommand(() =>
      Promise.resolve(
        report({
          pool: { status: 'failed', detail: 'xtrace: search failed with status 500' },
          relay: { status: 'failed', detail: 'relay down' },
          ok: false,
        }),
      ),
    );
    const result = await handler(context('x'));
    expect(result.exit).toBe(EXIT.expectedFailure);
    expect(result.lines[0]).toContain('pool and relay failed');
  });
});
