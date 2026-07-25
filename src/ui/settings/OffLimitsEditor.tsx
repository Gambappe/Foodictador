/**
 * The off-limits editor (U4).
 *
 * Off-limits topics live in `UsualProfile.offLimits`, and `UserStore.setUsual` is their
 * only write path (DAG §3) — so this screen edits a profile and saves it whole. It adds
 * no domain logic: it does not decide what "blocked" means (K2 does), and it does not
 * enforce anything (M5's write gate does). What it owns is making the consequence
 * legible before the user commits to it.
 *
 * The save port is injected rather than imported. The browser has no XTrace
 * credentials, and a component that constructs its own store cannot be tested against
 * the real one — which is exactly the integration this task's acceptance requires.
 */

import { useState } from 'react';

import type { UsualProfile } from '../../contracts/types.js';

export interface OffLimitsEditorProps {
  usual: UsualProfile;
  /** Writes through `UserStore.setUsual`; the caller owns the store. */
  onSave: (usual: UsualProfile) => Promise<void>;
}

/** Trim, drop empties, and fold case-duplicates — K2 matches case-insensitively. */
function normalise(topics: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of topics) {
    const topic = raw.trim();
    if (topic === '') continue;
    const key = topic.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(topic);
  }
  return out;
}

export function OffLimitsEditor({ usual, onSave }: OffLimitsEditorProps) {
  const [topics, setTopics] = useState<string[]>(() => normalise(usual.offLimits));
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function commit(next: string[]) {
    const normalised = normalise(next);
    setTopics(normalised);
    setSaving(true);
    setSaved(false);
    try {
      await onSave({ ...usual, offLimits: normalised });
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="off-limits-heading">
      <h2 id="off-limits-heading" className="text-lg font-semibold">
        Off-limits topics
      </h2>
      {/* [E24] in the user's own words: off-limits means nowhere, not "not shared". */}
      <p className="mt-1 text-sm text-muted">
        A confession touching one of these is not recorded anywhere — not in the pot, and
        not in your own memory.
      </p>

      <form
        className="mt-3 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.trim() === '') return;
          void commit([...topics, draft]);
          setDraft('');
        }}
      >
        <label htmlFor="off-limits-input" className="sr-only">
          Add a topic
        </label>
        <input
          id="off-limits-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="a topic you never want recorded"
          className="flex-1 rounded border border-muted/40 px-2 py-1"
        />
        <button type="submit" className="rounded bg-pot px-3 py-1 text-ground">
          Add
        </button>
      </form>

      <ul data-testid="off-limits-list" className="mt-3 flex flex-wrap gap-2">
        {topics.map((topic) => (
          <li key={topic.toLowerCase()} className="flex items-center gap-1 rounded-full bg-refusal/10 px-3 py-1 text-sm">
            <span>{topic}</span>
            <button
              type="button"
              aria-label={`Remove ${topic}`}
              onClick={() => void commit(topics.filter((t) => t !== topic))}
              className="text-refusal"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      {topics.length === 0 ? (
        <p className="mt-2 text-sm text-muted">Nothing is off limits yet.</p>
      ) : null}

      <p aria-live="polite" className="mt-2 text-sm text-muted">
        {saving ? 'Saving…' : saved ? 'Saved.' : ''}
      </p>
    </section>
  );
}
