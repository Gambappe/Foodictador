import { describe, expect, it } from 'vitest';

import { DEFAULT_FLAGS } from '../contracts/flags.js';
import type { SweepReport } from '../contracts/types.js';
import { createFlagStore, createLogger } from '../config/index.js';
import type { AppConfig } from '../config/index.js';
import { fixtureGraph } from '../config/wiring.js';
import { parseArgv } from './args.js';
import type { CommandContext } from './main.js';
import { EXIT } from './render.js';
import { createSweepCommand, watchIntervalMs } from './sweep.js';

const CONFIG: AppConfig = {
  xtraceBaseUrl: 'http://localhost:1',
  xtraceApiKey: 'k',
  relayUrl: 'http://localhost:2',
  relayToken: 't',
  anthropicApiKey: null,
  settleWindowSeconds: 480,
  proseBufferPath: '/tmp/confit-test-prose.json',
};

function context(args: string[], logLines: string[] = []): CommandContext {
  const logger = createLogger((m) => logLines.push(m));
  return {
    argv: parseArgv(args),
    config: CONFIG,
    flags: createFlagStore({ ...DEFAULT_FLAGS }, logger),
    logger,
    // These suites inject their own deps into the command factories, so the graph is
    // only here to satisfy CommandContext. Fixture stores, not live ones: a test that
    // constructed a live graph would build HTTP clients against invalid hosts.
    graph: fixtureGraph({ logger }),
  };
}

function report(overrides: Partial<SweepReport> = {}): SweepReport {
  return {
    pooled: 2,
    reingested: 1,
    pending: 4,
    stored: 3,
    oldestStoredAgeSeconds: 512,
    ...overrides,
  };
}

describe('X4 confit sweep --once', () => {
  it('runs one sweep and prints the counts, with pending called out', async () => {
    const nows: string[] = [];
    const handler = createSweepCommand({
      sweep: (now) => {
        nows.push(now);
        return Promise.resolve(report());
      },
      now: () => '2026-07-25T12:00:00.000Z',
    });
    const result = await handler(context(['sweep', '--once']));
    expect(nows).toEqual(['2026-07-25T12:00:00.000Z']);
    expect(result.exit ?? EXIT.ok).toBe(EXIT.ok);
    const printed = result.lines.join('\n');
    expect(printed).toContain('pooled (confirmed):   2');
    expect(printed).toContain('re-ingested:          1');
    // Labelled PENDING because that is the only number here an operator acts on
    // — under D-7 a growing `stored` is the product working, not a backlog.
    expect(printed).toContain('PENDING (unconfirmed): 4');
    expect(printed).toContain('reads stored:         3');
    expect(result.data).toMatchObject({
      mode: 'once',
      pending: 4,
      stored: 3,
      oldest_stored_age_seconds: 512,
    });
  });

  it('--once is the default when no mode flag is given', async () => {
    let calls = 0;
    const handler = createSweepCommand({
      sweep: () => {
        calls += 1;
        return Promise.resolve(report());
      },
    });
    const result = await handler(context(['sweep']));
    expect(calls).toBe(1);
    expect(result.data['mode']).toBe('once');
  });
});

describe('X4 confit sweep --watch', () => {
  it('loops on the config interval, logs each pass, and exits 0 on interrupt', async () => {
    const sleeps: number[] = [];
    let interrupt: () => void = () => {
      throw new Error('interrupt not registered');
    };
    let calls = 0;
    const logLines: string[] = [];

    const handler = createSweepCommand({
      sweep: () => {
        calls += 1;
        if (calls === 3) interrupt(); // SIGINT during the third pass
        return Promise.resolve(report({ pooled: 1, reingested: 0 }));
      },
      now: () => '2026-07-25T12:00:00.000Z',
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      onInterrupt: (callback) => {
        interrupt = callback;
      },
    });

    const result = await handler(context(['sweep', '--watch'], logLines));
    expect(result.exit).toBe(EXIT.ok); // SIGINT is the intended ending
    expect(calls).toBe(3);
    expect(result.data['passes']).toBe(3);
    expect(result.data['totals']).toEqual({ pooled: 3, reingested: 0, confessions: 0 });
    // One stderr line per pass, so the operator sees progress while it runs.
    expect(logLines.filter((l) => l.startsWith('sweep pass'))).toHaveLength(3);
    expect(logLines[0]).toContain('pending=4');
    // The interval comes from config's settle window.
    expect(sleeps.every((ms) => ms === watchIntervalMs(CONFIG.settleWindowSeconds))).toBe(true);
  });

  it('an interrupt during the sleep wakes the loop promptly', async () => {
    let interrupt: () => void = () => {};
    let sleptForever = false;
    const handler = createSweepCommand({
      sweep: () => Promise.resolve(report()),
      sleep: () =>
        new Promise<void>(() => {
          sleptForever = true;
          // never resolves — only the interrupt race can end the watch
          queueMicrotask(() => interrupt());
        }),
      onInterrupt: (callback) => {
        interrupt = callback;
      },
    });
    const result = await handler(context(['sweep', '--watch']));
    expect(sleptForever).toBe(true);
    expect(result.exit).toBe(EXIT.ok);
    expect(result.data['passes']).toBe(1);
  });
});

/**
 * SL-43 — the confession flush was written into `--once` only and tested nowhere.
 *
 * Deleting the flush from BOTH branches left the whole suite green, so half of what M20 added
 * to this command had no guard at all. `--watch` mattered most: it is the long-running form,
 * so a watch that never drained the buffer would hold a profile's last few confessions for
 * exactly as long as the operator kept the sweeper up.
 *
 * Red-verified: with the `flushProse` call removed from the `--once` branch the first two go
 * red; with it removed from the `--watch` loop the third and fourth do.
 */
describe('X4 sweep drains the confession buffer', () => {
  function withFlush(counts: number[], mode: 'once' | 'watch') {
    let interrupt: () => void = () => {};
    let pass = 0;
    const flushed: number[] = [];
    const handler = createSweepCommand({
      sweep: () => {
        pass += 1;
        if (pass === counts.length) queueMicrotask(() => interrupt());
        return Promise.resolve(report());
      },
      flushProse: () => {
        const next = counts[flushed.length] ?? 0;
        flushed.push(next);
        return Promise.resolve(next);
      },
      now: () => '2026-07-25T12:00:00.000Z',
      sleep: () => Promise.resolve(),
      onInterrupt: (callback) => {
        interrupt = callback;
      },
    });
    return { handler, flushed, argv: ['sweep', `--${mode}`] };
  }

  it('--once flushes, and reports how many confessions went', async () => {
    const h = withFlush([3], 'once');
    const result = await h.handler(context(h.argv));
    expect(h.flushed).toEqual([3]);
    expect(result.lines.join('\n')).toContain('confessions sent:     3');
    expect(result.data['confessions_sent']).toBe(3);
  });

  it('--once still sweeps when the flush throws — a buffer problem is not a sweep problem', async () => {
    const logLines: string[] = [];
    let swept = 0;
    const handler = createSweepCommand({
      sweep: () => {
        swept += 1;
        return Promise.resolve(report());
      },
      flushProse: () => Promise.reject(new Error('XTrace 503')),
      now: () => '2026-07-25T12:00:00.000Z',
    });
    const result = await handler(context(['sweep', '--once'], logLines));
    expect(swept).toBe(1);
    expect(result.exit ?? EXIT.ok).toBe(EXIT.ok);
    expect(logLines.some((l) => l.includes('confession flush failed'))).toBe(true);
  });

  it('--watch flushes on EVERY pass, not just the first', async () => {
    const h = withFlush([2, 1, 4], 'watch');
    const result = await h.handler(context(h.argv));
    expect(h.flushed).toEqual([2, 1, 4]);
    expect(result.data['passes']).toBe(3);
    expect(result.data['totals']).toEqual({ pooled: 6, reingested: 3, confessions: 7 });
  });

  it('--watch totals the confessions sent and prints them at the end', async () => {
    const h = withFlush([2, 1, 4], 'watch');
    const result = await h.handler(context(h.argv));
    expect(result.lines.join('\n')).toContain('confessions sent:      7');
  });
});

describe('X4 watch interval', () => {
  it('is half the settle window, floored for tiny test windows', () => {
    expect(watchIntervalMs(480)).toBe(240_000);
    expect(watchIntervalMs(1)).toBe(5_000);
  });
});
