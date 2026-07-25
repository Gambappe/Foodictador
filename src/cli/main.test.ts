import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/index.js';
import { UsageError, parseArgv } from './args.js';
import { EXIT } from './render.js';
import { COMMANDS, helpText, resolveCommand, run, validateInvocation } from './main.js';

const config: AppConfig = {
  xtraceBaseUrl: 'https://xtrace.invalid',
  xtraceApiKey: 'k',
  relayUrl: 'https://relay.invalid',
  relayToken: 't',
  anthropicApiKey: null,
  settleWindowSeconds: 480,
};

/** Runs an invocation with no environment and no real stores, capturing both streams. */
async function invoke(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    loadConfig: () => config,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('parseArgv', () => {
  it('separates subcommand words from options', () => {
    const parsed = parseArgv(['pass', 'census', '--json']);
    expect(parsed.tokens).toEqual(['pass', 'census']);
    expect(parsed.flags.has('json')).toBe(true);
  });

  it('accepts both --opt value and --opt=value', () => {
    expect(parseArgv(['--profile', 'A']).values.profile).toBe('A');
    expect(parseArgv(['--profile=A']).values.profile).toBe('A');
  });

  it('keeps a value containing spaces intact', () => {
    const text = 'I pretend to like the hot sauce';
    expect(parseArgv(['confess', '--text', text]).values.text).toBe(text);
  });

  it('does not swallow the next option as a value', () => {
    // `confit ask --profile --json` must fail rather than set profile to "--json".
    expect(() => parseArgv(['ask', '--profile', '--json'])).toThrow(UsageError);
  });

  it.each([
    [['--nope'], /unknown option "--nope"/],
    [['-j'], /short options are not supported/],
    [['--'], /bare "--"/],
    [['--json=1'], /--json does not take a value/],
    [['--profile='], /empty value/],
    [['--profile'], /--profile requires a value/],
  ])('rejects %s', (argv, message) => {
    expect(() => parseArgv(argv)).toThrow(message);
  });
});

describe('resolveCommand', () => {
  it('prefers the longest matching path', () => {
    expect(resolveCommand(['pass', 'census'])?.path).toEqual(['pass', 'census']);
  });

  it('returns null for an unknown command', () => {
    expect(resolveCommand(['brunch'])).toBeNull();
    expect(resolveCommand(['pass', 'brunch'])).toBeNull();
  });

  it('resolves a command that takes a positional without consuming it as a path word', () => {
    expect(resolveCommand(['forget', 'some-uuid'])?.path).toEqual(['forget']);
  });
});

/** Resolve a command, failing the test rather than asserting non-null. */
function mustResolve(tokens: string[]): NonNullable<ReturnType<typeof resolveCommand>> {
  const spec = resolveCommand(tokens);
  if (spec === null) throw new Error(`no such command: ${tokens.join(' ')}`);
  return spec;
}

describe('validateInvocation', () => {
  const forget = mustResolve(['forget']);
  const ask = mustResolve(['ask']);

  it('rejects an option the command does not accept', () => {
    expect(() => validateInvocation(ask, parseArgv(['ask', '--profile', 'A', '--yes']))).toThrow(
      /does not accept --yes/,
    );
  });

  it('accepts the globals on every command', () => {
    for (const spec of COMMANDS) {
      // Supply exactly what this command requires and nothing more, so the only thing
      // under test is whether --json is universally accepted.
      const argv = [...spec.path, '--json'];
      if (spec.requires?.includes('profile')) argv.push('--profile', 'A');
      if (spec.requires?.includes('text')) argv.push('--text', 'something');
      if (spec.positional?.required === true) argv.push('a-positional');
      expect(() => validateInvocation(spec, parseArgv(argv))).not.toThrow();
    }
  });

  it('rejects a missing required option', () => {
    expect(() => validateInvocation(ask, parseArgv(['ask']))).toThrow(/requires --profile/);
  });

  it('rejects a missing required positional', () => {
    expect(() => validateInvocation(forget, parseArgv(['forget']))).toThrow(/requires <read_id>/);
  });

  it('rejects an unexpected positional', () => {
    const census = mustResolve(['pass', 'census']);
    expect(() => validateInvocation(census, parseArgv(['pass', 'census', 'extra']))).toThrow(
      /takes no arguments/,
    );
  });

  it('rejects more than one positional', () => {
    expect(() => validateInvocation(forget, parseArgv(['forget', 'a', 'b']))).toThrow(
      /takes one argument/,
    );
  });

  it('rejects --once and --watch together, since DAG §5 lists them as alternatives', () => {
    const sweep = mustResolve(['sweep']);
    expect(() => validateInvocation(sweep, parseArgv(['sweep', '--once', '--watch']))).toThrow(
      /are alternatives/,
    );
    expect(() => validateInvocation(sweep, parseArgv(['sweep', '--once']))).not.toThrow();
    expect(() => validateInvocation(sweep, parseArgv(['sweep', '--watch']))).not.toThrow();
  });
});

describe('help', () => {
  it('lists every registered command', async () => {
    const { code, out } = await invoke('--help');
    expect(code).toBe(EXIT.ok);
    for (const spec of COMMANDS) {
      expect(out).toContain(spec.path.join(' '));
    }
  });

  it('names both npm-script entry points, which are not subcommands', () => {
    // DAG §4 D-4: gate0 and gate:cli deliberately live outside the CLI.
    const text = helpText().join('\n');
    expect(text).toContain('npm run gate0');
    expect(text).toContain('npm run gate:cli');
    expect(resolveCommand(['gate0'])).toBeNull();
  });

  it('shows help for a bare invocation', async () => {
    expect((await invoke()).code).toBe(EXIT.ok);
  });

  it('needs no environment at all', async () => {
    // X1's acceptance criterion: `npm run confit -- --help` exits 0, and CI has no
    // XTrace credentials — so help must resolve before config is ever loaded.
    const out: string[] = [];
    const code = await run(['--help'], {
      out: (text) => out.push(text),
      err: () => undefined,
      loadConfig: () => {
        throw new Error('config must not be loaded for --help');
      },
    });
    expect(code).toBe(EXIT.ok);
  });
});

describe('exit codes', () => {
  it('exits 2 on an unknown command', async () => {
    const { code, err } = await invoke('brunch');
    expect(code).toBe(EXIT.usage);
    expect(err).toContain('unknown command "brunch"');
  });

  it('suggests the subcommands when a known prefix is used bare', async () => {
    // `confit pass` on its own is a likely mistake, not an unknowable one.
    const { code, err } = await invoke('pass');
    expect(code).toBe(EXIT.usage);
    expect(err).toContain('pass census');
  });

  it('exits 2 on a missing required flag', async () => {
    expect((await invoke('ask')).code).toBe(EXIT.usage);
  });

  it('exits 2 on an unparseable option, before anything else happens', async () => {
    expect((await invoke('ask', '--nope')).code).toBe(EXIT.usage);
  });

  it('exits 3 when the environment is not configured', async () => {
    const err: string[] = [];
    const code = await run(['ask', '--profile', 'A'], {
      out: () => undefined,
      err: (text) => err.push(text),
      loadConfig: () => {
        throw new Error('Missing required environment variable(s): XTRACE_BASE_URL');
      },
    });
    expect(code).toBe(EXIT.environment);
    expect(err.join('\n')).toContain('XTRACE_BASE_URL');
  });

  it('exits 1 for a registered command that is not implemented yet', async () => {
    // Not 0: the command exists and was invoked correctly, and still could not do the job.
    // The specimen is picked dynamically: wiring a handler (an integrator change) must
    // not break this test, which is exactly what happened when it hard-coded `ask`.
    const spec = COMMANDS.find((candidate) => candidate.handler === undefined);
    if (spec === undefined) return; // every command wired — this test has retired itself
    const argv = [...spec.path];
    if (spec.requires?.includes('profile')) argv.push('--profile', 'A');
    if (spec.requires?.includes('text')) argv.push('--text', 'something');
    if (spec.positional?.required === true) argv.push('a-read-id');
    const { code, out } = await invoke(...argv);
    expect(code).toBe(EXIT.expectedFailure);
    expect(out).toContain('not implemented yet');
    expect(out).toContain(spec.task);
  });

  it('uses the four documented codes and nothing else', () => {
    expect(Object.values(EXIT).sort()).toEqual([0, 1, 2, 3]);
  });

  it('never reports an internal crash as exit 1', async () => {
    // gate:cli reads 1 as "ran correctly, answer was no". A handler that throws is a bug,
    // and reporting it as 1 would pass a gate that should fail.
    const err: string[] = [];
    const code = await run(['ask', '--profile', 'A'], {
      out: () => undefined,
      err: (text) => err.push(text),
      loadConfig: () => {
        throw new TypeError('boom');
      },
    });
    expect(code).not.toBe(EXIT.expectedFailure);
    expect(code).toBe(EXIT.environment);
    expect(err.join('\n')).toContain('boom');
  });
});

describe('--json', () => {
  it('emits parseable JSON for every still-placeholder command', async () => {
    // Wired commands are covered by their own suites (ask.test.ts, …) against
    // fixture stores — invoking them here would need real config and a live
    // substrate, and their payload is the command's, not the placeholder's.
    for (const spec of COMMANDS.filter((candidate) => candidate.handler === undefined)) {
      const argv = [...spec.path, '--json'];
      if (spec.requires?.includes('profile')) argv.push('--profile', 'A');
      if (spec.requires?.includes('text')) argv.push('--text', 'something');
      if (spec.positional?.required === true) argv.push('a-read-id');

      const { out } = await invoke(...argv);
      expect(() => JSON.parse(out) as unknown).not.toThrow();
      expect(JSON.parse(out)).toMatchObject({ command: spec.path.join(' ') });
    }
  });

  it('emits JSON for help, not prose', async () => {
    const { out } = await invoke('--help', '--json');
    expect((JSON.parse(out) as { commands: string[] }).commands).toContain('pass census');
  });

  it('emits JSON for a usage error too', async () => {
    const { err } = await invoke('brunch', '--json');
    expect(JSON.parse(err)).toMatchObject({ kind: 'usage' });
  });

  it('emits JSON even when parsing failed before options were known', async () => {
    // The bad flag aborts parsing, so --json has to be detected from the raw argv —
    // otherwise a machine consumer gets an English sentence exactly when it cannot
    // handle one.
    const { err } = await invoke('ask', '--nope', '--json');
    expect(JSON.parse(err)).toMatchObject({ kind: 'usage' });
  });

  it('writes nothing but the payload to stdout, so stdout stays parseable', async () => {
    const spec = COMMANDS.find((candidate) => candidate.handler === undefined);
    if (spec === undefined) return; // every command wired — covered by command suites
    const argv = [...spec.path, '--json'];
    if (spec.requires?.includes('profile')) argv.push('--profile', 'A');
    if (spec.requires?.includes('text')) argv.push('--text', 'something');
    if (spec.positional?.required === true) argv.push('a-read-id');
    const { out } = await invoke(...argv);
    expect(out.trimStart().startsWith('{')).toBe(true);
  });

  it('keeps errors on stderr so a --json consumer never has them mixed in', async () => {
    const { out, err } = await invoke('brunch', '--json');
    expect(out).toBe('');
    expect(err).not.toBe('');
  });
});

describe('the registry matches the documented surface', () => {
  it('registers every command in DAG §5 exactly once', () => {
    const paths = COMMANDS.map((spec) => spec.path.join(' '));
    expect(paths).toEqual([
      'confess',
      'ask',
      'sweep',
      'forget',
      'pass census',
      'pass neartie',
      'pass provision',
      'pass seed',
      'pass reset',
      'pass flags',
      'pass nudge',
    ]);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('names an owning task for every command, so no placeholder is orphaned', () => {
    for (const spec of COMMANDS) expect(spec.task).toMatch(/^X\d$/);
  });

  it('leaves no command orphaned: each has a handler or a task that owes one', () => {
    // Deliberately NOT "every command is still a placeholder" — that version would go red
    // the moment X2 lands, in a file X2 does not own (§2), handing its author a failure
    // they cannot legally fix. The durable invariant is that no command is a dead end.
    for (const spec of COMMANDS) {
      expect(spec.handler !== undefined || spec.task.length > 0).toBe(true);
    }
  });
});
