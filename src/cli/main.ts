/**
 * `confit` entry point and command dispatch (X1).
 *
 * This lane holds no business logic (DAG §1, §7 X1). Everything here is routing: parse
 * argv, resolve a subcommand, validate its options, load config if the command needs it,
 * hand off to a handler, render whatever comes back, exit with its code.
 *
 * Each command in the DAG §5 surface is registered now with a placeholder handler naming
 * the task that will replace it. That keeps `--help` honest about the whole surface while
 * the commands land one at a time, and it means X2–X7 each replace exactly one entry.
 */

import { pathToFileURL } from 'node:url';
import { askHandler } from './ask.js';
import {
  flagsHandler,
  nudgeHandler,
  provisionHandler,
  resetHandler,
  seedHandler,
} from './pass-ops.js';
import { loadConfig, createFlagStore, createLogger, initialFlags } from '../config/index.js';
import type { AppConfig, FlagStore, Logger } from '../config/index.js';
import {
  UsageError,
  isBooleanOption,
  isValueOption,
  parseArgv,
  type OptionName,
  type ParsedArgv,
} from './args.js';
import {
  EXIT,
  exitCodeOf,
  render,
  renderUsageError,
  type CommandResult,
  type ExitCode,
  type Sink,
} from './render.js';

/** What a command handler is given. Handlers are async; dispatch awaits them. */
export interface CommandContext {
  argv: ParsedArgv;
  config: AppConfig;
  flags: FlagStore;
  logger: Logger;
}

export type CommandHandler = (context: CommandContext) => Promise<CommandResult>;

export interface CommandSpec {
  /** Subcommand words, e.g. `['pass', 'census']`. */
  path: readonly string[];
  summary: string;
  /** Options this command accepts, beyond the globals. */
  options?: readonly OptionName[];
  /** Options without which the invocation is a usage error. */
  requires?: readonly OptionName[];
  /** A single trailing positional, if the command takes one. */
  positional?: { name: string; required: boolean };
  /** Option groups of which at most one member may be supplied. */
  exclusive?: readonly (readonly OptionName[])[];
  /** The task that owns the real implementation — named in the placeholder output. */
  task: string;
  handler?: CommandHandler;
}

/** Accepted by every command: asking for machine output or for help is never wrong. */
const GLOBAL_OPTIONS: readonly OptionName[] = ['json', 'help'];

/**
 * The DAG §5 surface. `gate0` and `gate:cli` are absent on purpose — they are npm scripts
 * owned by P0.5 and G5, not subcommands (DAG §4 D-4).
 *
 * **Wiring a handler is an integrator change, not a command author's.** This file belongs
 * to X1 (§2 ownership), so X2–X7 must NOT edit this table to register themselves: each
 * builds its own module under `src/cli/` and the integrator sets `handler` here when the
 * task merges. Same pattern plan v1.0 used for stub→live at the gates. A command author
 * who edits this table breaks the one rule that keeps two lanes off one file.
 */
export const COMMANDS: readonly CommandSpec[] = [
  {
    path: ['confess'],
    summary: 'record a confession: chips preview, confirm, then write',
    options: ['profile', 'text', 'yes'],
    requires: ['profile', 'text'],
    task: 'X2',
  },
  {
    path: ['ask'],
    summary: 'print the card for a profile',
    options: ['profile'],
    requires: ['profile'],
    task: 'X3',
    handler: askHandler,
  },
  {
    path: ['sweep'],
    summary: 'run the settle-sweeper once, or watch on an interval',
    options: ['once', 'watch'],
    exclusive: [['once', 'watch']],
    task: 'X4',
  },
  {
    path: ['forget'],
    summary: 'delete a read from both scopes and the relay',
    positional: { name: 'read_id', required: true },
    task: 'X5',
  },
  {
    path: ['pass', 'census'],
    summary: 'per-driver k, floor status, and the seed-manifest cross-check',
    task: 'X6',
  },
  {
    path: ['pass', 'neartie'],
    summary: 'score spread and the delta a judge read would apply',
    task: 'X6',
  },
  {
    path: ['pass', 'provision'],
    summary: 'create the demo profiles',
    options: ['profile'],
    task: 'X7',
    handler: provisionHandler,
  },
  {
    path: ['pass', 'seed'],
    summary: 'load the seed corpus into the pool and relay',
    task: 'X7',
    handler: seedHandler,
  },
  { path: ['pass', 'reset'], summary: 'clear the pool and relay', task: 'X7', handler: resetHandler },
  {
    path: ['pass', 'flags'],
    summary: 'show degrade flags, or set one with --set key=value',
    options: ['set'],
    task: 'X7',
    handler: flagsHandler,
  },
  {
    path: ['pass', 'nudge'],
    summary: 'arm the nudge with --arm',
    options: ['arm'],
    task: 'X7',
    handler: nudgeHandler,
  },
];

function formatPath(spec: CommandSpec): string {
  const positional = spec.positional === undefined ? '' : ` <${spec.positional.name}>`;
  return `confit ${spec.path.join(' ')}${positional}`;
}

export function helpText(): string[] {
  const width = Math.max(...COMMANDS.map((spec) => formatPath(spec).length));
  return [
    'confit — the whisper network for what to eat',
    '',
    'Usage: confit <command> [options]',
    '',
    'Commands:',
    ...COMMANDS.map((spec) => `  ${formatPath(spec).padEnd(width)}  ${spec.summary}`),
    '',
    'Options:',
    '  --profile <A|B>   which demo profile to act as',
    '  --text <text>     the confession text (confess)',
    '  --set <key=value> set a degrade flag (pass flags)',
    '  --yes             skip the confirmation prompt',
    '  --once, --watch   sweep once (default) or on an interval',
    '  --arm             arm the nudge',
    '  --json            print the machine payload instead of prose',
    '  --help            show this help',
    '',
    'Also: `npm run gate0` (gate zero) and `npm run gate:cli` (acceptance gate).',
  ];
}

/**
 * Longest-path match, so `pass census` resolves to that command rather than to a `pass`
 * command with a stray positional.
 */
export function resolveCommand(tokens: readonly string[]): CommandSpec | null {
  const candidates = COMMANDS.filter((spec) =>
    spec.path.every((word, index) => tokens[index] === word),
  );
  return candidates.reduce<CommandSpec | null>(
    (best, spec) => (best === null || spec.path.length > best.path.length ? spec : best),
    null,
  );
}

/**
 * Rejects options the command does not accept, options it requires but did not get, and a
 * missing or unexpected positional. Throws `UsageError`, which dispatch maps to exit 2.
 */
export function validateInvocation(spec: CommandSpec, argv: ParsedArgv): void {
  const allowed = new Set<OptionName>([...GLOBAL_OPTIONS, ...(spec.options ?? [])]);
  const supplied: OptionName[] = [
    ...Object.keys(argv.values).filter(isValueOption),
    ...argv.flags,
  ];
  for (const option of supplied) {
    if (!allowed.has(option)) {
      throw new UsageError(`\`${formatPath(spec)}\` does not accept --${option}`);
    }
  }

  for (const option of spec.requires ?? []) {
    const present = isBooleanOption(option)
      ? argv.flags.has(option)
      : isValueOption(option) && argv.values[option] !== undefined;
    if (!present) throw new UsageError(`\`${formatPath(spec)}\` requires --${option}`);
  }

  for (const group of spec.exclusive ?? []) {
    const given = group.filter((option) =>
      isBooleanOption(option) ? argv.flags.has(option) : argv.values[option] !== undefined,
    );
    if (given.length > 1) {
      const names = given.map((option) => `--${option}`).join(' and ');
      throw new UsageError(`\`${formatPath(spec)}\`: ${names} are alternatives`);
    }
  }

  const positionals = argv.tokens.slice(spec.path.length);
  if (spec.positional === undefined) {
    if (positionals.length > 0) {
      throw new UsageError(`\`${formatPath(spec)}\` takes no arguments, got "${positionals[0]}"`);
    }
    return;
  }
  if (positionals.length > 1) {
    throw new UsageError(`\`${formatPath(spec)}\` takes one argument, got ${positionals.length}`);
  }
  if (spec.positional.required && positionals.length === 0) {
    throw new UsageError(`\`${formatPath(spec)}\` requires <${spec.positional.name}>`);
  }
}

/**
 * Stands in until the owning task lands. Exit 1 rather than 0: the command exists and was
 * invoked correctly, and it still could not do the thing asked of it.
 */
function placeholder(spec: CommandSpec): CommandHandler {
  const name = spec.path.join(' ');
  return () =>
    Promise.resolve({
      lines: [`\`confit ${name}\` is not implemented yet — task ${spec.task} owns it.`],
      data: { command: name, implemented: false, task: spec.task },
      exit: EXIT.expectedFailure,
    });
}

/** An unknown thrown value as a one-line message, for failures the user caused. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * An unknown thrown value with its stack, for failures we caused. Separate from
 * `messageOf` on purpose: a usage error should not print a stack trace, and a bug should
 * not hide one.
 */
function detailOf(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

export interface RunDeps {
  out?: Sink;
  err?: Sink;
  /** Injected in tests so no environment is required. */
  loadConfig?: () => AppConfig;
}

/**
 * Runs one invocation and returns its exit code. Never calls `process.exit`, so tests can
 * assert the code instead of trapping an exit.
 */
export async function run(argv: readonly string[], deps: RunDeps = {}): Promise<ExitCode> {
  const out = deps.out ?? ((text: string) => process.stdout.write(`${text}\n`));
  const err = deps.err ?? ((text: string) => process.stderr.write(`${text}\n`));

  // Detected from the raw argv because parsing can fail before options are known, and a
  // caller that asked for machine output must not get prose back on a bad flag.
  const json = argv.includes('--json');

  let parsed: ParsedArgv;
  try {
    parsed = parseArgv(argv);
  } catch (error) {
    renderUsageError(messageOf(error), { json }, err);
    return EXIT.usage;
  }

  // Help and usage errors must work with no environment at all: `npm run confit -- --help`
  // is X1's acceptance criterion and CI has no XTrace credentials.
  if (parsed.flags.has('help') || parsed.tokens.length === 0) {
    const commands = COMMANDS.map((spec) => spec.path.join(' '));
    render({ lines: helpText(), data: { commands } }, { json }, out);
    return EXIT.ok;
  }

  const spec = resolveCommand(parsed.tokens);
  if (spec === null) {
    const attempted = parsed.tokens.join(' ');
    const under = COMMANDS.filter((candidate) => candidate.path[0] === parsed.tokens[0]);
    const alternatives = under.map((candidate) => candidate.path.join(' ')).join(', ');
    const hint = alternatives === '' ? '' : ` — did you mean one of: ${alternatives}?`;
    renderUsageError(`unknown command "${attempted}"${hint}`, { json }, err);
    return EXIT.usage;
  }

  try {
    validateInvocation(spec, parsed);
  } catch (error) {
    renderUsageError(messageOf(error), { json }, err);
    return EXIT.usage;
  }

  const logger = createLogger(err);
  let config: AppConfig;
  try {
    config = (deps.loadConfig ?? loadConfig)();
  } catch (error) {
    const message = messageOf(error);
    render(
      { lines: [`error: ${message}`], data: { error: message, kind: 'environment' } },
      { json },
      err,
    );
    return EXIT.environment;
  }

  const handler = spec.handler ?? placeholder(spec);
  let result: CommandResult;
  try {
    result = await handler({
      argv: parsed,
      config,
      flags: createFlagStore(initialFlags(config, logger), logger),
      logger,
    });
  } catch (error) {
    // An unexpected throw is a bug, not an outcome. It must NOT surface as exit 1:
    // `gate:cli` treats 1 as "ran correctly, answer was no", and a crash reported that
    // way would pass a gate it should fail. 3 is the closest documented code — the CLI
    // could not run — and the stack goes to stderr so the bug is not swallowed.
    const message = detailOf(error);
    render(
      { lines: [`internal error: ${message}`], data: { error: message, kind: 'internal' } },
      { json },
      err,
    );
    return EXIT.environment;
  }
  render(result, { json }, out);
  return exitCodeOf(result);
}

/** Only self-executes as a script, so importing this module in a test runs nothing. */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = await run(process.argv.slice(2));
}
