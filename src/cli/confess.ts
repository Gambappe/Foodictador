/**
 * `confit confess` (X2) — the CLI half of the confess flow.
 *
 * Text → L2 proposes five chips → the author sees them and the consent copy → confirm →
 * M5's write path. No domain logic lives here: blocking is K2 via M5, minting and
 * validation are K1, the write order is M5's. This module decides what the operator sees
 * and what the exit code says.
 *
 * Two things it is responsible for getting right:
 *
 *  1. **The consent copy** (design v0.8 `[E27]`). The chip screen used to imply that five
 *     fields were all that left the device. They are not: the prose goes to the author's
 *     own Confit memory. Both halves are stated before anything is written.
 *  2. **Never printing the word "weight".** The read's fifth field is called `weight`, and
 *     `weight` is in K5's banned lexicon because design v0.8 §9 forbids the product
 *     commenting on it. The field name is a schema detail; a diner reading "weight: 0.81"
 *     next to a description of their eating is exactly what §9 exists to prevent. It is
 *     labelled `strength` in prose and stays `weight` in the JSON payload.
 */

import { createInterface } from 'node:readline/promises';
import type { Extractor } from '../contracts/modules.js';
import type { Read } from '../contracts/types.js';
import { writeRead, type WriteReadDeps } from '../memory/writeRead.js';
import type { CommandContext, CommandHandler } from './main.js';
import { EXIT, type CommandResult } from './render.js';

type Chips = Omit<Read, 'read_id'>;

export interface ConfessDeps {
  extractor: Extractor;
  write: WriteReadDeps;
  /**
   * Asks the author to approve. Injected rather than reading stdin here, so the whole
   * command is testable without a TTY. `--yes` skips it entirely.
   */
  confirm: (chips: Chips) => Promise<boolean>;
}

export interface ConfessInput {
  profile: string;
  text: string;
  assumeYes: boolean;
}

/** Design v0.8 `[E27]`: both halves, before the button, every time. */
export const CONSENT_LINES: readonly string[] = [
  'Your words go to your private Confit memory, which Confit holds.',
  'Only the five fields above go to the pot, with nothing linking them to you.',
];

const REFUSAL =
  'That touches a topic you marked off-limits, so nothing was recorded — ' +
  'not the pot, not the relay, not your own memory.';

function humanise(value: string): string {
  return value.replaceAll('_', ' ');
}

/**
 * The five chips as the author sees them.
 *
 * `strength` rather than `weight`: see the module docstring. The label is deliberate, not
 * a paraphrase, and `renders no banned term` in the tests holds it in place.
 */
export function chipLines(chips: Chips): string[] {
  return [
    `  place     ${chips.place}`,
    `  signal    ${humanise(chips.signal)}`,
    `  driver    ${humanise(chips.driver)}`,
    `  cadence   ${chips.cadence}`,
    `  strength  ${chips.weight.toFixed(2)}`,
  ];
}

interface WroteFlags {
  relay: boolean;
  pool: boolean;
  job: boolean;
  prose: boolean;
}

function targetLines(wrote: WroteFlags): string[] {
  const mark = (ok: boolean): string => (ok ? 'ok' : 'FAILED');
  return [
    `  relay          ${mark(wrote.relay)}   (makes it visible on other devices now)`,
    `  pool           ${mark(wrote.pool)}   (settles over the next few minutes)`,
    `  ingest handle  ${mark(wrote.job)}   (best-effort; the sweeper falls back without it)`,
    `  your memory    ${mark(wrote.prose)}   (your words, your tier only)`,
  ];
}

export async function confess(deps: ConfessDeps, input: ConfessInput): Promise<CommandResult> {
  // `usual()` returns null for a profile that was never provisioned — it does not throw.
  // Treating that as an exception would have crashed on the null instead; a fresh checkout
  // is a normal state, so say what to run.
  const profile = await deps.write.user.usual(input.profile);
  if (profile === null) {
    return {
      lines: [
        `No profile "${input.profile}" yet.`,
        `Run \`confit pass provision --profile ${input.profile}\` first.`,
      ],
      data: { blocked: false, wrote: null, kind: 'no_profile' },
      exit: EXIT.expectedFailure,
    };
  }
  const offLimits = profile.offLimits;

  const proposed = await deps.extractor.propose(input.text, offLimits);
  if ('blocked' in proposed) {
    return {
      lines: [REFUSAL],
      data: { blocked: true, wrote: null },
      exit: EXIT.expectedFailure,
    };
  }

  const { chips } = proposed;
  const preview = [
    'This is what would be shared:',
    ...chipLines(chips),
    '',
    ...CONSENT_LINES,
  ];

  if (!input.assumeYes && !(await deps.confirm(chips))) {
    return {
      lines: [...preview, '', 'Not added to the pot. Nothing was written.'],
      data: { blocked: false, approved: false, wrote: null, chips },
      exit: EXIT.ok, // Declining is the gate working, not a failure.
    };
  }

  const result = await writeRead(deps.write, {
    profile: input.profile,
    text: input.text,
    chips,
    offLimits,
  });

  if ('blocked' in result) {
    // M5's check is the authoritative one; reaching here means L2's earlier pass missed
    // something. The refusal is identical either way — the author should not be able to
    // tell which layer stopped it.
    return { lines: [REFUSAL], data: { blocked: true, wrote: null }, exit: EXIT.expectedFailure };
  }

  const pooled = result.wrote.relay;
  return {
    lines: [
      ...preview,
      '',
      `Added to the pot as ${result.read_id}.`,
      ...targetLines(result.wrote),
      ...result.warnings.map((warning) => `  ! ${warning}`),
      ...(pooled ? [] : ['', 'This read is NOT pooled — the relay write failed.']),
    ],
    data: {
      blocked: false,
      approved: true,
      read_id: result.read_id,
      chips,
      wrote: result.wrote,
      warnings: result.warnings,
      pooled,
    },
    // A failed relay write means the read never became visible to anyone else, which is
    // the whole point of pooling it — so that is an expected failure. A failed pool write
    // is recoverable by the sweeper from the relay entry, so it is a warning, not a code.
    exit: pooled ? EXIT.ok : EXIT.expectedFailure,
  };
}

/**
 * The default confirmation: one line from stdin, anything but `y`/`yes` declines.
 *
 * Declining is the safe answer, so a stray newline, a closed pipe or a `^D` all mean no —
 * `[E24]`'s gate is worth nothing if an ambiguous keystroke pools a confession.
 */
export async function stdinConfirm(prompt = 'Add to the pot? [y/N] '): Promise<boolean> {
  // The prompt goes to stderr, not stdout: results own stdout (X1's render
  // contract), so `pass reset --json | jq` must not be fed a question.
  const io = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await io.question(prompt);
    // Anything that is not an explicit yes is a no. A destructive command must
    // not read a stray newline as consent.
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    io.close();
  }
}

/**
 * Adapts `confess` to X1's `CommandHandler`, so wiring it into the registry is one
 * assignment. Building the real stores is integrator work — nothing in the DAG owns
 * adapter construction, which is worth a task of its own.
 */
export function createConfessHandler(
  deps: Omit<ConfessDeps, 'confirm'> & { confirm?: ConfessDeps['confirm'] },
): CommandHandler {
  return (context: CommandContext) => {
    // X1 has already guaranteed both are present: `confess` declares them required.
    const profile = context.argv.values.profile ?? '';
    const text = context.argv.values.text ?? '';
    return confess(
      { ...deps, confirm: deps.confirm ?? (() => stdinConfirm()) },
      { profile, text, assumeYes: context.argv.flags.has('yes') },
    );
  };
}

/** The production handler: real stores from P0.6's graph, stdin for the confirmation. */
export const confessCommand: CommandHandler = (context: CommandContext) => {
  const graph = context.graph;
  return createConfessHandler({
    extractor: graph.extractor,
    write: { relay: graph.relay, pool: graph.pool, user: graph.user, logger: graph.logger },
  })(context);
};
