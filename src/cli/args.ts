/**
 * Argument parsing for the `confit` CLI (X1). Pure: no `process`, no I/O, no exits —
 * it turns an argv array into a parsed shape or throws `UsageError`.
 *
 * Kept separate from `main.ts` so the whole surface can be tested by passing arrays of
 * strings, with no subprocess and no environment.
 */

/** Options that take a value: `--profile A`, `--profile=A`. */
export const VALUE_OPTIONS = ['profile', 'text', 'set'] as const;
export type ValueOption = (typeof VALUE_OPTIONS)[number];

/** Options that are present or absent: `--json`. */
export const BOOLEAN_OPTIONS = ['json', 'yes', 'help', 'once', 'watch', 'arm'] as const;
export type BooleanOption = (typeof BOOLEAN_OPTIONS)[number];

export type OptionName = ValueOption | BooleanOption;

/** Wrong invocation — exit code 2. Distinct from a command that ran and failed. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface ParsedArgv {
  /** Non-option words, in order: the subcommand path then any positionals. */
  tokens: string[];
  values: Readonly<Partial<Record<ValueOption, string>>>;
  flags: ReadonlySet<BooleanOption>;
}

export function isValueOption(name: string): name is ValueOption {
  return (VALUE_OPTIONS as readonly string[]).includes(name);
}

export function isBooleanOption(name: string): name is BooleanOption {
  return (BOOLEAN_OPTIONS as readonly string[]).includes(name);
}

/**
 * Parses `--flag`, `--opt value` and `--opt=value`.
 *
 * Short flags are deliberately unsupported: nothing in the CLI surface (DAG §5) uses one,
 * and silently accepting `-j` for `--json` would invite a second spelling for every option
 * that later has to keep working.
 */
export function parseArgv(argv: readonly string[]): ParsedArgv {
  const tokens: string[] = [];
  const values: Partial<Record<ValueOption, string>> = {};
  const flags = new Set<BooleanOption>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;

    if (!argument.startsWith('--')) {
      if (argument.startsWith('-') && argument !== '-') {
        throw new UsageError(`unknown option "${argument}" (short options are not supported)`);
      }
      tokens.push(argument);
      continue;
    }

    const body = argument.slice(2);
    if (body === '') throw new UsageError('bare "--" is not an option');

    const equals = body.indexOf('=');
    const name = equals === -1 ? body : body.slice(0, equals);
    const inlineValue = equals === -1 ? null : body.slice(equals + 1);

    if (isBooleanOption(name)) {
      if (inlineValue !== null) throw new UsageError(`--${name} does not take a value`);
      flags.add(name);
      continue;
    }

    if (!isValueOption(name)) throw new UsageError(`unknown option "--${name}"`);

    if (inlineValue !== null) {
      if (inlineValue === '') throw new UsageError(`--${name} was given an empty value`);
      values[name] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    // A following `--something` is the next option, not this one's value — otherwise
    // `confit ask --profile --json` would silently set profile to "--json".
    if (next === undefined || next.startsWith('--')) {
      throw new UsageError(`--${name} requires a value`);
    }
    values[name] = next;
    index += 1;
  }

  return { tokens, values, flags };
}
