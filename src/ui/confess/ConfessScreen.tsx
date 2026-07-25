/**
 * The confess screen (U2) — two beats, per design v0.8 §5.
 *
 * Textarea and submit; then the proposed read as five editable, strikeable chips and
 * **Add to the pot**. Nothing is pooled without that press.
 *
 * No domain logic (DAG §7 U1). L2 proposes the chips, K2 decides what "off-limits"
 * means, M5's `writeRead` is the authoritative gate and the only writer — this file
 * gathers input and renders outcomes. Both are injected as ports because the browser
 * holds no XTrace credentials and the acceptance has to drive the real write path.
 *
 * Striking a chip disables the pot button rather than dropping a field: the pooled read
 * is exactly six fields, closed ([E25]), so a withheld field means there is no read to
 * pool at all. That is [E24]'s "don't share this" honoured without inventing a
 * five-field write the contract does not have.
 */

import { useState } from 'react';

import { CADENCES, DRIVERS, SIGNALS, type ProposedRead, type Read } from '../../contracts/types.js';
import {
  CHIP_LABELS,
  CONSENT,
  MEMORY_RECEIPT,
  REFUSAL,
  REFUSAL_SCOPE,
  STRUCK_NOTICE,
} from './copy.js';

/**
 * Sent, held, or failed — see `MEMORY_RECEIPT`. `wrote.prose` is `true` for a buffered
 * confession as much as a sent one, so it cannot carry this on its own (SL-42).
 */
function memoryLine(prose: boolean, buffered: number): string {
  if (!prose) return MEMORY_RECEIPT.failed;
  return buffered === 0 ? MEMORY_RECEIPT.sent : MEMORY_RECEIPT.held;
}

type Chips = Omit<Read, 'read_id'>;

/** What M5's write path reports back, narrowed to what a screen needs to say. */
export interface ConfessOutcome {
  blocked?: true;
  read_id?: string;
  wrote?: { relay: boolean; pool: boolean; job: boolean; prose: boolean };
  /**
   * Confessions waiting for a batch, `0` when this one was sent (M20).
   *
   * `wrote.prose` alone cannot describe the outcome any more: it is `true` both for a
   * confession that reached XTrace and for one sitting in a local buffer, and rendering
   * "written" for the second is untrue at the moment it is shown (SL-42).
   */
  proseBuffered?: number;
  warnings?: string[];
}

export interface ConfessScreenProps {
  offLimits: readonly string[];
  /** L2's chip preview. UI-only per §6 — it may be wrong, never unsafe. */
  propose: (text: string, offLimits: string[]) => Promise<ProposedRead | { blocked: true }>;
  /** M5's writeRead, bound to a profile by the caller. The only writer. */
  submit: (chips: Chips, text: string) => Promise<ConfessOutcome>;
}

type Phase =
  | { kind: 'writing-prose' }
  | { kind: 'proposing' }
  | { kind: 'chips'; chips: Chips }
  | { kind: 'blocked' }
  | { kind: 'saving'; chips: Chips }
  | { kind: 'done'; outcome: ConfessOutcome };

function EnumChip<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (next: T) => void;
}) {
  return (
    <label className="flex flex-col text-sm">
      <span className="text-muted">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        className="rounded border border-muted/40 px-2 py-1"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option.replaceAll('_', ' ')}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ConfessScreen({ offLimits, propose, submit }: ConfessScreenProps) {
  const [text, setText] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'writing-prose' });
  const [struck, setStruck] = useState<ReadonlySet<keyof Chips>>(new Set());

  async function preview(event: React.FormEvent) {
    event.preventDefault();
    if (text.trim() === '') return;
    setPhase({ kind: 'proposing' });
    const proposed = await propose(text, [...offLimits]);
    setPhase('blocked' in proposed ? { kind: 'blocked' } : { kind: 'chips', chips: proposed.chips });
  }

  async function addToPot(chips: Chips) {
    setPhase({ kind: 'saving', chips });
    const outcome = await submit(chips, text);
    // M5 is the authoritative check: a topic L2 missed still stops here, and the
    // author must not be able to tell which layer refused.
    setPhase(outcome.blocked === true ? { kind: 'blocked' } : { kind: 'done', outcome });
  }

  function toggleStrike(field: keyof Chips) {
    setStruck((current) => {
      const next = new Set(current);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
  }

  if (phase.kind === 'blocked') {
    return (
      <section aria-labelledby="confess-heading">
        <h1 id="confess-heading" className="text-2xl font-semibold">
          Confess
        </h1>
        <p data-testid="refusal" className="mt-3 rounded border border-refusal/40 bg-refusal/5 p-3 text-refusal">
          {REFUSAL}
        </p>
        {/* D-9: what off-limits does not do. Separate element so a test can assert it is
            present without matching on the refusal's own wording. */}
        <p data-testid="refusal-scope" className="mt-2 text-sm text-muted">
          {REFUSAL_SCOPE}
        </p>
      </section>
    );
  }

  if (phase.kind === 'done') {
    const wrote = phase.outcome.wrote;
    return (
      <section aria-labelledby="confess-heading">
        <h1 id="confess-heading" className="text-2xl font-semibold">
          Added to the pot
        </h1>
        <p data-testid="read-id" className="mt-2 text-sm text-muted">
          {phase.outcome.read_id}
        </p>
        <ul data-testid="write-report" className="mt-3 text-sm">
          <li>pot: {wrote?.pool === true ? 'written' : 'not written'}</li>
          <li>relay: {wrote?.relay === true ? 'written' : 'not written'}</li>
          {/*
            Three states, not two (M20/SL-42). A buffered confession is on this device and
            not in XTrace, so "written" would overstate it — the same defect the CLI receipt
            was fixed for, and D-10's one named consequence.
          */}
          <li>your memory: {memoryLine(wrote?.prose === true, phase.outcome.proseBuffered ?? 0)}</li>
        </ul>
        {(phase.outcome.warnings ?? []).map((warning) => (
          <p key={warning} className="mt-2 text-sm text-refusal">
            {warning}
          </p>
        ))}
      </section>
    );
  }

  if (phase.kind === 'chips' || phase.kind === 'saving') {
    const { chips } = phase;
    const setChip = <K extends keyof Chips>(key: K, value: Chips[K]) => {
      setPhase({ kind: 'chips', chips: { ...chips, [key]: value } });
    };
    const anyStruck = struck.size > 0;

    return (
      <section aria-labelledby="confess-heading">
        <h1 id="confess-heading" className="text-2xl font-semibold">
          This is what would be shared
        </h1>

        <div data-testid="chips" className="mt-4 grid gap-3">
          <label className="flex flex-col text-sm">
            <span className="text-muted">{CHIP_LABELS.place}</span>
            <input
              value={chips.place}
              onChange={(event) => setChip('place', event.target.value)}
              className="rounded border border-muted/40 px-2 py-1"
            />
          </label>
          <EnumChip
            label={CHIP_LABELS.signal}
            value={chips.signal}
            options={SIGNALS}
            onChange={(next) => setChip('signal', next)}
          />
          <EnumChip
            label={CHIP_LABELS.driver}
            value={chips.driver}
            options={DRIVERS}
            onChange={(next) => setChip('driver', next)}
          />
          <EnumChip
            label={CHIP_LABELS.cadence}
            value={chips.cadence}
            options={CADENCES}
            onChange={(next) => setChip('cadence', next)}
          />
          <label className="flex flex-col text-sm">
            <span className="text-muted">{CHIP_LABELS.weight}</span>
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={chips.weight}
              onChange={(event) => setChip('weight', Number(event.target.value))}
              className="rounded border border-muted/40 px-2 py-1"
            />
          </label>

          <div className="flex flex-wrap gap-2">
            {(Object.keys(CHIP_LABELS) as Array<keyof Chips>).map((field) => (
              <button
                key={field}
                type="button"
                aria-pressed={struck.has(field)}
                onClick={() => toggleStrike(field)}
                className={struck.has(field) ? 'text-refusal line-through' : 'text-muted'}
              >
                strike {CHIP_LABELS[field]}
              </button>
            ))}
          </div>
        </div>

        {anyStruck ? (
          <p data-testid="struck-notice" className="mt-3 text-sm text-refusal">
            {STRUCK_NOTICE}
          </p>
        ) : null}

        {/* [E27]: both halves, above the button, every time. */}
        <div data-testid="consent" className="mt-4 rounded bg-muted/5 p-3 text-sm">
          <p>{CONSENT.words}</p>
          <p>{CONSENT.fields}</p>
        </div>

        <button
          type="button"
          disabled={anyStruck || phase.kind === 'saving'}
          onClick={() => void addToPot(chips)}
          className="mt-4 rounded bg-pot px-4 py-2 text-ground disabled:opacity-40"
        >
          Add to the pot
        </button>
      </section>
    );
  }

  return (
    <section aria-labelledby="confess-heading">
      <h1 id="confess-heading" className="text-2xl font-semibold">
        Confess
      </h1>
      <p className="mt-1 text-muted">One true thing you would never put in a review.</p>
      <form className="mt-3" onSubmit={(event) => void preview(event)}>
        <label htmlFor="confession" className="sr-only">
          Your confession
        </label>
        <textarea
          id="confession"
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={5}
          autoComplete="off"
          className="w-full rounded border border-muted/40 p-2"
        />
        <button
          type="submit"
          disabled={phase.kind === 'proposing'}
          className="mt-2 rounded bg-pot px-4 py-2 text-ground disabled:opacity-40"
        >
          {phase.kind === 'proposing' ? 'Reading…' : 'Continue'}
        </button>
      </form>
    </section>
  );
}
