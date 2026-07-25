/**
 * The Pass panel (U5) — the operator's view over `confit pass`, per design v0.8 §5.
 *
 * Census table, near-tie inspector, sweeper status, flag toggles, and the provision /
 * seed / reset operations. Every one of them is an entry in `actions.ts`, and every
 * entry names a real CLI command path, so the panel is physically unable to perform an
 * operation the CLI does not have. `actions.test.ts` checks that against the CLI's own
 * registry.
 *
 * **This file renders; it does not decide.** Every number and verdict on screen is read
 * out of the `CommandResult` the CLI produced — `citable` is the flag the census
 * reported, not `k >= KFLOOR` recomputed here; `ok` is the near-tie command's verdict,
 * not a comparison of spread against the max. That is what "a view over the CLI, not a
 * second implementation" has to mean to be worth anything: if the panel recomputed, an
 * operator could see a green census while `confit pass census` exits non-zero, which is
 * precisely the rehearsal-morning failure [E22] exists to prevent.
 *
 * Where a payload does not have the shape this panel expects, it falls back to the
 * command's own `lines`. Those are always present, so a payload change downstream
 * degrades to plain CLI output rather than to a blank panel or a wrong number.
 */

import { useCallback, useState } from 'react';

import type { CommandResult } from '../../cli/render.js';
import {
  FLAG_CHOICES,
  PASS_ACTIONS,
  passAction,
  type FlagName,
  type PassAction,
  type PassActionId,
} from './actions.js';

/** Runs one action. The host supplies the CLI; the browser holds no credentials. */
export type RunPass = (
  action: PassAction,
  values: Readonly<Record<string, string>>,
) => Promise<CommandResult>;

export interface PassPanelProps {
  run: RunPass;
}

// ---------------------------------------------------------------------------
// payload readers — narrow, never derive

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const num = (value: unknown): number | null => (typeof value === 'number' ? value : null);
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const bool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

interface CensusRow {
  driver: string;
  k: number;
  citable: boolean;
  manifest: number;
  crosscheck: string;
}

function censusRows(data: Record<string, unknown>): CensusRow[] | null {
  const raw = data['drivers'];
  if (!Array.isArray(raw)) return null;
  const rows: CensusRow[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) return null;
    const driver = str(entry['driver']);
    const k = num(entry['k']);
    const citable = bool(entry['citable']);
    const manifest = num(entry['manifest']);
    const crosscheck = str(entry['crosscheck']);
    if (driver === null || k === null || citable === null || manifest === null || crosscheck === null) {
      return null;
    }
    rows.push({ driver, k, citable, manifest, crosscheck });
  }
  return rows;
}

interface TopEntry {
  place: string;
  score: number;
}

function topThree(data: Record<string, unknown>): TopEntry[] | null {
  const raw = data['top3'];
  if (!Array.isArray(raw)) return null;
  const entries: TopEntry[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) return null;
    const place = str(entry['place']);
    const score = num(entry['score']);
    if (place === null || score === null) return null;
    entries.push({ place, score });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// shared presentation

/** A command's own output. The fallback whenever a payload is not what we expect. */
function Lines({ result, testId }: { result: CommandResult; testId: string }) {
  return (
    <pre data-testid={testId} className="mt-2 whitespace-pre-wrap text-xs text-muted">
      {result.lines.join('\n')}
    </pre>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section data-testid={`section-${id}`} className="mt-6 rounded border border-muted/30 p-4">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/**
 * The exit code, shown rather than swallowed.
 *
 * A census that exits 1 is the whole point of running one; a panel that displayed the
 * table and hid the verdict would be a worse tool than the terminal it replaces.
 */
function Verdict({ result, testId }: { result: CommandResult; testId: string }) {
  const failed = (result.exit ?? 0) !== 0;
  return (
    <p
      data-testid={testId}
      className={`mt-2 text-sm ${failed ? 'text-refusal' : 'text-muted'}`}
    >
      exit {result.exit ?? 0}
      {failed ? ' — do not start the demo on this' : ''}
    </p>
  );
}

// ---------------------------------------------------------------------------

export function PassPanel({ run }: PassPanelProps) {
  const [results, setResults] = useState<Partial<Record<PassActionId, CommandResult>>>({});
  const [busy, setBusy] = useState<PassActionId | null>(null);
  const [failures, setFailures] = useState<Partial<Record<PassActionId, string>>>({});
  const [confirming, setConfirming] = useState<PassActionId | null>(null);

  const [flagName, setFlagName] = useState<FlagName>('pool');
  const [flagValue, setFlagValue] = useState<string>('relay-only');
  const [profile, setProfile] = useState('all');

  const invoke = useCallback(
    async (id: PassActionId, values: Readonly<Record<string, string>> = {}) => {
      const action = passAction(id);
      setBusy(id);
      setConfirming(null);
      try {
        const result = await run(action, values);
        setResults((current) => ({ ...current, [id]: result }));
        setFailures((current) => ({ ...current, [id]: undefined }));
      } catch (error) {
        // An operator mid-demo needs to know the command did not run. Swallowing this
        // would leave the previous result on screen looking current.
        setFailures((current) => ({
          ...current,
          [id]: error instanceof Error ? error.message : String(error),
        }));
      } finally {
        setBusy(null);
      }
    },
    [run],
  );

  /** Mutations get a confirm step; reads run on the first press. */
  const press = (id: PassActionId, values: Readonly<Record<string, string>> = {}) => {
    if (passAction(id).mutates && confirming !== id) {
      setConfirming(id);
      return;
    }
    void invoke(id, values);
  };

  function ActionButton({
    id,
    values = {},
  }: {
    id: PassActionId;
    values?: Readonly<Record<string, string>>;
  }) {
    const action = passAction(id);
    const armed = confirming === id;
    return (
      <span className="inline-flex items-center gap-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => press(id, values)}
          className={`rounded px-3 py-1 text-sm text-ground disabled:opacity-40 ${
            armed ? 'bg-refusal' : 'bg-pot'
          }`}
        >
          {busy === id ? 'Running…' : armed ? `Confirm: ${action.label}` : action.label}
        </button>
        {armed ? (
          <button
            type="button"
            onClick={() => setConfirming(null)}
            className="text-sm text-muted underline"
          >
            Cancel
          </button>
        ) : null}
        <code className="text-xs text-muted">confit {action.path.join(' ')}</code>
      </span>
    );
  }

  function Failure({ id }: { id: PassActionId }) {
    const message = failures[id];
    if (message === undefined) return null;
    return (
      <p data-testid={`failure-${id}`} className="mt-2 text-sm text-refusal">
        {passAction(id).label} did not run: {message}
      </p>
    );
  }

  const census = results.census;
  const rows = census ? censusRows(census.data) : null;
  const neartie = results.neartie;
  const top3 = neartie ? topThree(neartie.data) : null;
  const sweeper = results.sweeper;
  const flagsRead = results.flags;
  const flagsSet = results['flags-set'];

  return (
    <section aria-labelledby="pass-heading">
      <h1 id="pass-heading" className="text-2xl font-semibold">
        The Pass
      </h1>
      <p className="mt-1 text-muted">
        Every control here runs a <code>confit</code> command. Nothing on this screen
        computes anything the CLI would not.
      </p>

      <Section id="census" title="Census">
        <p className="text-sm text-muted">{passAction('census').blurb}</p>
        <div className="mt-2">
          <ActionButton id="census" />
        </div>
        <Failure id="census" />
        {census ? (
          rows ? (
            <>
              <table data-testid="census-table" className="mt-3 w-full text-left text-sm">
                <thead>
                  <tr className="text-muted">
                    <th scope="col">driver</th>
                    <th scope="col">k</th>
                    <th scope="col">floor</th>
                    <th scope="col">manifest</th>
                    <th scope="col">cross-check</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.driver} data-testid={`census-row-${row.driver}`}>
                      <td>{row.driver}</td>
                      <td>{row.k}</td>
                      {/* The census's own verdict, not k >= KFLOOR recomputed here. */}
                      <td className={row.citable ? '' : 'text-refusal'}>
                        {row.citable ? 'citable' : 'below floor'}
                      </td>
                      <td>{row.manifest}</td>
                      <td className={row.crosscheck === 'MISMATCH' ? 'text-refusal' : ''}>
                        {row.crosscheck}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {census.data['degraded'] === true ? (
                <p data-testid="census-degraded" className="mt-2 text-sm text-refusal">
                  Pool degraded — counts come from the induction set plus the relay.
                </p>
              ) : null}
            </>
          ) : (
            <Lines result={census} testId="census-lines" />
          )
        ) : null}
        {census ? <Verdict result={census} testId="census-verdict" /> : null}
      </Section>

      <Section id="neartie" title="Near-tie inspector">
        <p className="text-sm text-muted">{passAction('neartie').blurb}</p>
        <div className="mt-2">
          <ActionButton id="neartie" />
        </div>
        <Failure id="neartie" />
        {neartie ? (
          top3 ? (
            <>
              <dl data-testid="neartie-spread" className="mt-3 text-sm">
                <dt className="text-muted">spread (top1 − top3)</dt>
                <dd>
                  {String(neartie.data['spread'])} (max {String(neartie.data['near_tie_gap_max'])})
                </dd>
                <dt className="mt-2 text-muted">worst judge shift</dt>
                <dd>
                  {String(neartie.data['worst_shift'])} (min{' '}
                  {String(neartie.data['judge_shift_min'])})
                </dd>
              </dl>
              <ol data-testid="neartie-top3" className="mt-2 text-sm">
                {top3.map((entry, index) => (
                  <li key={entry.place}>
                    top{index + 1}: {entry.place} score={entry.score}
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <Lines result={neartie} testId="neartie-lines" />
          )
        ) : null}
        {neartie ? <Verdict result={neartie} testId="neartie-verdict" /> : null}
      </Section>

      <Section id="sweeper" title="Sweeper status">
        <p className="text-sm text-muted">{passAction('sweeper').blurb}</p>
        <div className="mt-2">
          <ActionButton id="sweeper" values={{ once: 'true' }} />
        </div>
        <Failure id="sweeper" />
        {sweeper ? (
          <dl data-testid="sweeper-status" className="mt-3 text-sm">
            <dt className="text-muted">oldest_entry_age_seconds</dt>
            <dd data-testid="oldest-entry-age">
              {String(sweeper.data['oldest_entry_age_seconds'])}
            </dd>
            <dt className="mt-2 text-muted">verified &amp; dropped</dt>
            <dd>{String(sweeper.data['verified'])}</dd>
            <dt className="mt-2 text-muted">re-ingested</dt>
            <dd>{String(sweeper.data['reingested'])}</dd>
            <dt className="mt-2 text-muted">retained on relay</dt>
            <dd>{String(sweeper.data['retained'])}</dd>
          </dl>
        ) : null}
      </Section>

      <Section id="flags" title="Degrade flags">
        <div className="flex flex-wrap items-center gap-2">
          <ActionButton id="flags" />
        </div>
        <Failure id="flags" />
        {flagsRead ? <Lines result={flagsRead} testId="flags-lines" /> : null}

        <div className="mt-4 flex flex-wrap items-end gap-2">
          <label className="flex flex-col text-sm">
            <span className="text-muted">flag</span>
            <select
              aria-label="flag"
              value={flagName}
              onChange={(event) => {
                const next = event.target.value as FlagName;
                setFlagName(next);
                // Keep the value legal for the newly selected flag rather than sending
                // `narrator=relay-only` and getting a usage error back.
                setFlagValue(FLAG_CHOICES[next][0]);
                setConfirming(null);
              }}
              className="rounded border border-muted/40 px-2 py-1"
            >
              {(Object.keys(FLAG_CHOICES) as FlagName[]).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-sm">
            <span className="text-muted">value</span>
            <select
              aria-label="value"
              value={flagValue}
              onChange={(event) => {
                setFlagValue(event.target.value);
                setConfirming(null);
              }}
              className="rounded border border-muted/40 px-2 py-1"
            >
              {FLAG_CHOICES[flagName].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <ActionButton id="flags-set" values={{ set: `${flagName}=${flagValue}` }} />
        </div>
        <Failure id="flags-set" />
        {flagsSet ? <Lines result={flagsSet} testId="flags-set-lines" /> : null}
      </Section>

      <Section id="operations" title="Operations">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col text-sm">
            <span className="text-muted">profile</span>
            <select
              aria-label="profile"
              value={profile}
              onChange={(event) => {
                setProfile(event.target.value);
                setConfirming(null);
              }}
              className="rounded border border-muted/40 px-2 py-1"
            >
              {['all', 'A', 'B'].map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <ActionButton id="provision" values={{ profile }} />
        </div>
        <Failure id="provision" />
        {results.provision ? <Lines result={results.provision} testId="provision-lines" /> : null}

        <div className="mt-4">
          <ActionButton id="seed" />
        </div>
        <Failure id="seed" />
        {results.seed ? <Lines result={results.seed} testId="seed-lines" /> : null}

        <div className="mt-4">
          <ActionButton id="reset" />
          <p className="mt-1 text-sm text-muted">{passAction('reset').blurb}</p>
        </div>
        <Failure id="reset" />
        {results.reset ? <Lines result={results.reset} testId="reset-lines" /> : null}
      </Section>

      <p className="mt-6 text-xs text-muted">
        Commands available:{' '}
        {PASS_ACTIONS.map((action) => `confit ${action.path.join(' ')}`)
          .filter((label, index, all) => all.indexOf(label) === index)
          .join(' · ')}
      </p>
    </section>
  );
}
