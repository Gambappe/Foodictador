/**
 * `confit sweep` (X4) — the operator-run settle-sweeper (design v0.8 [E21]):
 * the command that must work when the author's session is gone.
 *
 * `--once` (the default) runs one pass and prints the report. `--watch` loops
 * on an interval derived from config's settle window, logging one line per
 * pass to stderr (results own stdout, X1's render contract) and printing the
 * totals when interrupted — SIGINT ends the loop cleanly with exit 0.
 *
 * No business logic here: M7 decides what a sweep does; this module owns the
 * timer M7 deliberately does not have. Registered in main.ts by the
 * integrator (X1 owns that file).
 */

import type { SweepReport } from '../contracts/types.js';
import { createFetchTransport, createMemoryClient } from '../memory/client.js';
import { createPoolStore } from '../memory/pool.js';
import { createRelayClient } from '../memory/relay.js';
import { createSweeper } from '../memory/sweeper.js';
import type { CommandContext, CommandHandler } from './main.js';
import { EXIT, type CommandResult } from './render.js';

/**
 * Sweeping much faster than the settle window burns queries on entries that
 * cannot be ready yet; half the window keeps a stuck entry visible within one
 * demo beat. Floored so a test-sized window cannot spin the loop hot.
 */
export function watchIntervalMs(settleWindowSeconds: number): number {
  return Math.max(5, settleWindowSeconds / 2) * 1000;
}

export interface SweepCommandDeps {
  sweep: (now: string) => Promise<SweepReport>;
  now?: () => string;
  sleep?: (ms: number) => Promise<void>;
  /** Registers the interrupt callback; defaults to `process.once('SIGINT')`. */
  onInterrupt?: (callback: () => void) => void;
}

function reportLines(report: SweepReport, heading: string): string[] {
  return [
    heading,
    `  verified & dropped: ${report.verified}`,
    `  re-ingested:        ${report.reingested}`,
    `  retained on relay:  ${report.retained}`,
    `  oldest_entry_age_seconds: ${report.oldestEntryAgeSeconds}`,
  ];
}

function reportData(report: SweepReport): Record<string, unknown> {
  return {
    verified: report.verified,
    reingested: report.reingested,
    retained: report.retained,
    oldest_entry_age_seconds: report.oldestEntryAgeSeconds,
  };
}

export function createSweepCommand(deps: SweepCommandDeps): CommandHandler {
  const now = deps.now ?? (() => new Date().toISOString());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const onInterrupt =
    deps.onInterrupt ??
    ((callback: () => void) => {
      process.once('SIGINT', callback);
    });

  return async (context: CommandContext): Promise<CommandResult> => {
    if (!context.argv.flags.has('watch')) {
      const report = await deps.sweep(now());
      return {
        lines: reportLines(report, 'Sweep report:'),
        data: { mode: 'once', ...reportData(report) },
      };
    }

    // --watch: sweep, log one line, sleep, repeat — until SIGINT. The race
    // makes the sleep interruptible, so exit is prompt, not next-interval.
    let interrupted = false;
    let wake: () => void = () => {};
    const interruptedPromise = new Promise<void>((resolve) => {
      onInterrupt(() => {
        interrupted = true;
        resolve();
      });
      wake = resolve;
    });
    void wake;

    const intervalMs = watchIntervalMs(context.config.settleWindowSeconds);
    let passes = 0;
    let last: SweepReport = { verified: 0, reingested: 0, retained: 0, oldestEntryAgeSeconds: 0 };
    const totals = { verified: 0, reingested: 0 };

    while (!interrupted) {
      last = await deps.sweep(now());
      passes += 1;
      totals.verified += last.verified;
      totals.reingested += last.reingested;
      context.logger.line(
        `sweep pass ${passes}: verified=${last.verified} reingested=${last.reingested} retained=${last.retained} oldest_entry_age_seconds=${last.oldestEntryAgeSeconds}`,
      );
      await Promise.race([sleep(intervalMs), interruptedPromise]);
    }

    return {
      lines: [
        `Watch ended after ${passes} pass(es).`,
        `  verified & dropped (total): ${totals.verified}`,
        `  re-ingested (total):        ${totals.reingested}`,
        `  retained on relay (last):   ${last.retained}`,
        `  oldest_entry_age_seconds:   ${last.oldestEntryAgeSeconds}`,
      ],
      data: {
        mode: 'watch',
        passes,
        totals: { ...totals },
        last: reportData(last),
      },
      exit: EXIT.ok, // SIGINT is how a watch is supposed to end
    };
  };
}

/** The production handler: real relay, pool, and sweeper from config. */
export const sweepCommand: CommandHandler = (context: CommandContext) => {
  const client = createMemoryClient(
    createFetchTransport({
      baseUrl: context.config.xtraceBaseUrl,
      apiKey: context.config.xtraceApiKey,
    }),
  );
  const relay = createRelayClient({
    url: context.config.relayUrl,
    token: context.config.relayToken,
    logger: context.logger,
  });
  const pool = createPoolStore({ client, logger: context.logger });
  const sweeper = createSweeper({
    relay,
    pool,
    client,
    logger: context.logger,
    settleWindowSeconds: context.config.settleWindowSeconds,
  });
  const handler = createSweepCommand({ sweep: (nowIso) => sweeper.sweepOnce(nowIso) });
  return handler(context);
};
