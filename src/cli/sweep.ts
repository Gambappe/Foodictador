/**
 * `confit sweep` (X4) — the operator-run induction backfill (design v0.8 [E21]):
 * the command that must work when the author's session is gone.
 *
 * Under DAG §4 D-7 a sweep no longer drains the relay — the relay is the durable
 * store and M7 deletes nothing. What a sweep does now is confirm XTrace ingested
 * each settled read and re-send the ones it did not, so the report counts
 * induction coverage rather than a shrinking backlog.
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
  /**
   * Sends any buffered confessions, whatever the count (M20).
   *
   * Here because this command already owns the deferred substrate work, and because the
   * buffer's size threshold alone would leave a profile's last few confessions unsent
   * indefinitely. Returns how many were sent.
   */
  flushProse?: () => Promise<number>;
  now?: () => string;
  sleep?: (ms: number) => Promise<void>;
  /** Registers the interrupt callback; defaults to `process.once('SIGINT')`. */
  onInterrupt?: (callback: () => void) => void;
}

/**
 * `pending` is the line an operator is meant to act on — under D-7 the sweeper
 * deletes nothing, so a growing store is normal and only an unconfirmed entry
 * means something is wrong. It is labelled to say so, because the number it
 * replaced ("retained on relay") looked like a backlog and is now just a count
 * of everything Confit knows.
 */
function reportLines(report: SweepReport, heading: string): string[] {
  return [
    heading,
    `  pooled (confirmed):   ${report.pooled}`,
    `  re-ingested:          ${report.reingested}`,
    `  PENDING (unconfirmed): ${report.pending}`,
    `  reads stored:         ${report.stored}`,
    `  oldest_stored_age_seconds: ${report.oldestStoredAgeSeconds}`,
  ];
}

/**
 * The `--json` payload. Exported so U5's `actions.test.ts` can check the Pass panel's
 * field names against the real thing: D-7 renamed every key in `SweepReport`, and the
 * panel went on reading the old ones while its own fixtures staged them back.
 */
export function sweepPayload(report: SweepReport): Record<string, unknown> {
  return {
    pooled: report.pooled,
    reingested: report.reingested,
    pending: report.pending,
    stored: report.stored,
    oldest_stored_age_seconds: report.oldestStoredAgeSeconds,
  };
}

/**
 * Flushes the confession buffer, and never lets that failure take the sweep down.
 *
 * A sweep exists to keep the substrate consistent; refusing to report the pool's state
 * because a confession batch could not be sent would trade the useful half for the
 * best-effort one. D-10 sanctions losing confessions, so this cannot be the fatal step.
 */
async function flushProse(deps: SweepCommandDeps, context: CommandContext): Promise<number> {
  if (deps.flushProse === undefined) return 0;
  try {
    return await deps.flushProse();
  } catch (error) {
    context.logger.line(
      `sweep: confession flush failed, sweep continues: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 0;
  }
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
      const prose = await flushProse(deps, context);
      const report = await deps.sweep(now());
      return {
        lines: [...reportLines(report, 'Sweep report:'), `  confessions sent:     ${prose}`],
        data: { mode: 'once', ...sweepPayload(report), confessions_sent: prose },
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
    let last: SweepReport = {
      pooled: 0,
      reingested: 0,
      pending: 0,
      stored: 0,
      oldestStoredAgeSeconds: 0,
    };
    const totals = { pooled: 0, reingested: 0 };

    while (!interrupted) {
      last = await deps.sweep(now());
      passes += 1;
      totals.pooled += last.pooled;
      totals.reingested += last.reingested;
      context.logger.line(
        `sweep pass ${passes}: pooled=${last.pooled} reingested=${last.reingested} pending=${last.pending} stored=${last.stored}`,
      );
      await Promise.race([sleep(intervalMs), interruptedPromise]);
    }

    return {
      lines: [
        `Watch ended after ${passes} pass(es).`,
        `  pooled (total):        ${totals.pooled}`,
        `  re-ingested (total):   ${totals.reingested}`,
        `  PENDING (last):        ${last.pending}`,
        `  reads stored (last):   ${last.stored}`,
      ],
      data: {
        mode: 'watch',
        passes,
        totals: { ...totals },
        last: sweepPayload(last),
      },
      exit: EXIT.ok, // SIGINT is how a watch is supposed to end
    };
  };
}

/** The production handler: real relay, pool, and sweeper from config. */
export const sweepCommand: CommandHandler = (context: CommandContext) => {
  const graph = context.graph;
  const sweeper = createSweeper({
    relay: graph.relay,
    pool: graph.pool,
    client: graph.client,
    logger: graph.logger,
    settleWindowSeconds: graph.settleWindowSeconds,
  });
  const handler = createSweepCommand({
    sweep: (nowIso) => sweeper.sweepOnce(nowIso),
    flushProse: () => graph.user.flushProse(),
  });
  return handler(context);
};
