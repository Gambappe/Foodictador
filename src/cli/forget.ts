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
import { createFetchTransport, createMemoryClient } from '../memory/client.js';
import { createRelayClient } from '../memory/relay.js';
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

function headline(report: ForgetReport): string {
  if (!report.ok) {
    const failed = (['pool', 'relay', 'user'] as const)
      .filter((target) => report[target].status === 'failed')
      .join(' and ');
    return `Not fully deleted from Confit — ${failed} failed. Run it again once that recovers.`;
  }
  const touched = (['pool', 'relay', 'user'] as const).some(
    (target) => report[target].status === 'deleted',
  );
  return touched
    ? `Deleted from Confit: ${report.read_id}`
    : `Nothing stored under ${report.read_id} — already gone from Confit.`;
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
      ],
      data: { ...report },
      exit: report.ok ? EXIT.ok : EXIT.expectedFailure,
    };
  };
}

/** The production handler: real XTrace client and relay from config. */
export const forgetCommand: CommandHandler = (context) => {
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
  const handler = createForgetCommand((readId) =>
    forget(readId, { client, relay, logger: context.logger }),
  );
  return handler(context);
};
