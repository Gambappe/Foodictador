/**
 * `confit forget <read_id>` (X5) — the CLI face of M8's per-target deletion.
 *
 * No business logic here (DAG §1): M8 decides what deletion means; this module
 * renders its report and maps it to an exit code. The copy register is
 * "deleted from Confit" — deletion is app-mediated, and nothing printed here
 * may imply cryptographic enforcement (design v0.8 §7).
 *
 * Registered in main.ts by the integrator, not here (X1 owns that file).
 */

import type { ForgetReport, ForgetTargetReport } from '../memory/forget.js';
import { forget } from '../memory/forget.js';
import type { CommandContext, CommandHandler } from './main.js';
import { EXIT, type CommandResult } from './render.js';

export type RunForget = (readId: string) => Promise<ForgetReport>;

function targetLine(name: string, report: ForgetTargetReport): string {
  const label = `  ${name}:`.padEnd(9);
  switch (report.status) {
    case 'deleted': {
      const count = report.count ?? 1;
      return `${label}deleted${count > 1 ? ` (${count} records)` : ''}`;
    }
    case 'nothing_to_delete':
      return `${label}nothing to delete`;
    case 'skipped':
      return `${label}skipped — ${report.detail ?? 'not attempted'}`;
    case 'failed':
      return `${label}FAILED — ${report.detail ?? 'unknown error'}`;
  }
}

const TARGETS = ['pool', 'relay', 'user', 'buffer'] as const;

/**
 * A target is "resolved" once it is `deleted` or `nothing_to_delete` — the two
 * outcomes that mean there is nothing left under that scope for this read.
 * `skipped` is neither: M8 could not even attempt it (no captured handles),
 * so something the user asked to be forgotten may still be sitting in that
 * scope. SL-19: the old check only asked whether ANY target was `deleted`,
 * so a fully skipped user-scope confession still produced "Deleted from
 * Confit" — the overclaim the deletion story exists to prevent.
 */
function headline(report: ForgetReport): string {
  if (!report.ok) {
    const failed = TARGETS.filter((target) => report[target].status === 'failed').join(' and ');
    return `Not fully deleted from Confit — ${failed} failed. Run it again once that recovers.`;
  }
  const deleted = TARGETS.some((target) => report[target].status === 'deleted');
  const skipped = TARGETS.some((target) => report[target].status === 'skipped');

  // Everything resolved and nothing was there: the one case where absence is KNOWN.
  if (!deleted && !skipped) {
    return `Nothing stored under ${report.read_id} — already gone from Confit.`;
  }

  // Nothing deleted, and the relay — the store of record (D-7) — never held this id.
  //
  // Two overclaims are available here and this line takes neither (SL-62). Saying "partly
  // deleted … your own words are still in your memory" asserts that their words ARE somewhere,
  // for a read that never existed: a specific, false, privacy-relevant claim from the one
  // command whose whole job is to be believed about where words are. Saying "nothing is stored
  // under it" asserts the opposite and is equally unearned, because the personal tier was not
  // checked — prose is not keyed by read_id, which is what `skipped` on that target means.
  //
  // So it states what is known (no such read, nothing deleted) and names what was not checked.
  if (!deleted && report.relay.status === 'nothing_to_delete') {
    return (
      `No read with id ${report.read_id} — nothing was deleted, and your own memory was ` +
      `not checked (it is not keyed by read id).`
    );
  }

  if (skipped) {
    return `Partly deleted from Confit: ${report.read_id} — your own words are still in your memory.`;
  }
  return `Deleted from Confit: ${report.read_id}`;
}

/** Success (exit 0) requires every target resolved — not merely "not failed". */
function fullyResolved(report: ForgetReport): boolean {
  return report.ok && TARGETS.every((target) => report[target].status !== 'skipped');
}

/** The handler with its backend injected — tests drive this directly. */
export function createForgetCommand(runForget: RunForget): CommandHandler {
  return async (context: CommandContext): Promise<CommandResult> => {
    // main.ts validated the invocation; the positional follows the path word.
    const readId = context.argv.tokens[1];
    if (readId === undefined) throw new Error('forget: read_id missing after validation');

    const report = await runForget(readId);
    return {
      lines: [
        headline(report),
        targetLine('pool', report.pool),
        targetLine('relay', report.relay),
        targetLine('user', report.user),
        // The local copy M20 introduced. Named `buffer` rather than folded into `user`, so a
        // skipped one is visible: a confession this could not reach is one the next flush
        // sends after `forget` said it was gone (SL-50).
        targetLine('buffer', report.buffer),
      ],
      data: { ...report },
      exit: fullyResolved(report) ? EXIT.ok : EXIT.expectedFailure,
    };
  };
}

/** The production handler: real XTrace client and relay from config. */
export const forgetCommand: CommandHandler = (context) => {
  const graph = context.graph;
  const handler = createForgetCommand((readId) =>
    forget(readId, {
      client: graph.client,
      relay: graph.relay,
      buffer: graph.buffer,
      logger: graph.logger,
    }),
  );
  return handler(context);
};
