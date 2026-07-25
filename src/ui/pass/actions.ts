/**
 * The Pass panel's action registry (U5).
 *
 * Every button on the panel is one entry here, and every entry names a **real CLI
 * command path**. That is the whole design: the panel cannot invent an operation,
 * because the only thing it is able to express is "run this `confit` command". DAG §7
 * U5's acceptance — "every action maps to an existing `confit pass` operation, the panel
 * is a view over the CLI, not a second implementation" — is then a mechanical check
 * rather than a promise, and `actions.test.ts` runs it against `COMMANDS` itself.
 *
 * `sends` lists option names, not values. The names are what can be checked against the
 * CLI's own spec; values come from the operator at press time. An action that sent an
 * option the command does not accept, or omitted one it requires, would be a broken
 * invocation — the test catches both, so a typo here fails in CI rather than at the
 * terminal during a rehearsal.
 *
 * Note `sweeper` is `confit sweep`, not `confit pass …`. The sweeper status the spec asks
 * for (with `oldest_entry_age_seconds`) has no `pass` subcommand; X4 put it on `sweep`.
 * Reaching for the relay's `stats()` directly from here would have satisfied the letter
 * of "a pass operation" by breaking the rule that matters — U1's "if a screen needs
 * behaviour the CLI cannot do, that behaviour belongs in a kernel or memory task first".
 * So the panel calls the command that already exists.
 */

/** A pass-panel button, bound to one CLI invocation. */
export interface PassAction {
  /** Stable key: test ids, React keys, and the `run` port's discriminator. */
  readonly id: string;
  /** The CLI command path, verbatim — `['pass', 'census']` is `confit pass census`. */
  readonly path: readonly string[];
  readonly label: string;
  /** What the operator is told the button does, before they press it. */
  readonly blurb: string;
  /** Option names this action supplies. Checked against the command's own spec. */
  readonly sends: readonly string[];
  /**
   * Whether the action changes state. Mutations get a confirm step: The Pass is operated
   * during a live demo and `reset` is one mis-click from an empty relay.
   */
  readonly mutates: boolean;
}

export const PASS_ACTIONS = [
  {
    id: 'census',
    path: ['pass', 'census'],
    label: 'Run census',
    blurb: 'Per-driver k, floor status, and the seed-manifest cross-check ([E22]).',
    sends: [],
    mutates: false,
  },
  {
    id: 'neartie',
    path: ['pass', 'neartie'],
    label: 'Inspect near-tie',
    blurb: 'Score spread between top1 and top3, and the shift a judge read applies.',
    sends: [],
    mutates: false,
  },
  {
    id: 'sweeper',
    path: ['sweep'],
    label: 'Sweeper status',
    blurb: 'One sweeper pass: verified, re-ingested, retained, and oldest_entry_age_seconds.',
    sends: ['once'],
    mutates: true,
  },
  {
    id: 'flags',
    path: ['pass', 'flags'],
    label: 'Read flags',
    blurb: 'Show the current degrade flags.',
    sends: [],
    mutates: false,
  },
  {
    id: 'flags-set',
    path: ['pass', 'flags'],
    label: 'Set flag',
    blurb: 'Set one degrade flag. One logged transition per change.',
    sends: ['set'],
    mutates: true,
  },
  {
    id: 'provision',
    path: ['pass', 'provision'],
    label: 'Provision profiles',
    blurb: 'Write the committed demo profiles through UserStore.',
    sends: ['profile'],
    mutates: true,
  },
  {
    id: 'seed',
    path: ['pass', 'seed'],
    label: 'Load seeds',
    blurb: 'Load the seed corpus into the pool and the relay.',
    sends: [],
    mutates: true,
  },
  {
    id: 'reset',
    path: ['pass', 'reset'],
    label: 'Clear relay',
    blurb: 'Clear the relay. Pool records remain — the substrate has no bulk delete.',
    sends: [],
    mutates: true,
  },
] as const satisfies readonly PassAction[];

export type PassActionId = (typeof PASS_ACTIONS)[number]['id'];

export function passAction(id: PassActionId): PassAction {
  const found = PASS_ACTIONS.find((action) => action.id === id);
  // Unreachable while `id` is the literal union above; a runtime throw beats returning
  // a fake action that would render an empty panel section and look like "no data".
  if (!found) throw new Error(`unknown pass action: ${id}`);
  return found;
}

/** The flags the panel offers, and the values each accepts — mirrors X7's own table. */
export const FLAG_CHOICES = {
  extraction: ['live', 'seeded'],
  narrator: ['live', 'template'],
  pool: ['live', 'relay-only'],
  demoMode: ['true', 'false'],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type FlagName = keyof typeof FLAG_CHOICES;
