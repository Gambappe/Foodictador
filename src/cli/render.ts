/**
 * Output for the `confit` CLI (X1). Pure apart from the sink it is handed.
 *
 * Every command returns a `CommandResult` and renders nothing itself (DAG §7, X1:
 * "rendering is separate from logic"). That split is what lets X2–X7 be tested on the
 * object they return rather than on scraped stdout, and it is why `--json` works for every
 * command without each one having to remember to support it.
 */

/**
 * The four exit codes the CLI may return (DAG §7, X1).
 *
 * `expectedFailure` is the interesting one: the command ran correctly and the *outcome*
 * is a failure — a blocked topic, a partial deletion. A cohort miss is NOT one of these;
 * it is a normal card.
 */
export const EXIT = {
  ok: 0,
  expectedFailure: 1,
  usage: 2,
  environment: 3,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export interface CommandResult {
  /** Human-readable output, one entry per line. Empty is legal. */
  lines: string[];
  /** The machine payload printed under `--json`. Must be JSON-serialisable. */
  data: Record<string, unknown>;
  /** Defaults to `EXIT.ok` when a command does not say otherwise. */
  exit?: ExitCode;
}

export type Sink = (text: string) => void;

/** A command's exit code, defaulting to success. */
export function exitCodeOf(result: CommandResult): ExitCode {
  return result.exit ?? EXIT.ok;
}

/**
 * Writes a result to `out`.
 *
 * Under `--json` the payload is the only thing written, so stdout stays machine-parseable
 * — human lines and log output go elsewhere (the logger writes to stderr for the same
 * reason). Tests and `gate:cli` depend on that being true of every command.
 */
export function render(result: CommandResult, options: { json: boolean }, out: Sink): void {
  if (options.json) {
    out(JSON.stringify(result.data, null, 2));
    return;
  }
  for (const line of result.lines) out(line);
}

/**
 * A usage failure, rendered.
 *
 * Still emits JSON under `--json`, because a caller that asked for machine output and got
 * a bare English sentence on a bad flag has to special-case parsing exactly once — and
 * will forget.
 */
export function renderUsageError(message: string, options: { json: boolean }, out: Sink): void {
  render(
    {
      lines: [`error: ${message}`, '', 'Run `confit --help` for the command list.'],
      data: { error: message, kind: 'usage' },
    },
    options,
    out,
  );
}
