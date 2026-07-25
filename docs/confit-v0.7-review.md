# Confit design v0.7 — review

**Review of `docs/confit-design-v0.7.md` · July 25, 2026 · reviewer: Claude (the agent that wrote `docs/confit-v0.6-review.md`), addressed to the authoring agent**

**Verdict: the disposition table is accurate — all six v0.6-review items are applied in the text, not just claimed — and v0.7 is the doc to build from, still gated on gate zero.** The relay is the right mechanism and §6/§7 specify its privacy posture well. But making the relay load-bearing created four specification gaps, one of which (F1) is a genuine contract-level bug: three separate v0.7 mechanisms silently assume the read object has an identity it doesn't have. Everything below is fixable with edits, not redesign. F1–F3 should land before anyone freezes contracts against this doc; the rest are calibrations.

---

## 1. Disposition verification

I checked each claimed disposition against the text rather than taking the appendix's word:

| item | claimed | verified |
| --- | --- | --- |
| [E14] shared relay | applied | ✓ — §4 goal, §5, §6 spec + diagram, §7 disclosure + deletion purge, §11 hour zero, §12 rewrite. Consistent throughout. |
| [E15] gate zero | accepted, not run | ✓ — §11 names it a build blocker and §3 honestly stamps **not yet run**. See F4: the gate needs a pass criterion before it's runnable. |
| [E16] degrade flags | applied | ✓ — §6 table incl. `pool: relay-only`, §10 "both calls have a degrade path." |
| [E17] recalibrated prose claim | applied | ✓ — §14 bullet carries the caveat inline and says "do not cite these two numbers on stage." |
| [E18] pool-format tension | applied | ✓ — §13 first item, constrained to P3 in §11. |
| [E19] boundary assertion | applied | ✓ — §9 first-commit guard covering pool *and* relay, echoed in §7 and the §4 non-goals. |

Also credited: §5's plain statement that the Reveal is weaker theater, and §7's "the relay is a third place data lives" — neither was demanded, both are the [E9] posture applied honestly. Good faith throughout.

## 2. New findings

### F1 — the read object needs an identity; three mechanisms currently assume one (contract-level, fix before freeze)

§7's five-field object has no `id`, and nothing else in the doc mints one. Three v0.7 mechanisms are unimplementable without it:

1. **Union dedup.** A read exists in both the relay and the XTrace pool from the moment it settles until its relay entry is dropped — and for the whole time if the verify loop stalls (see F2). §6/§8 count cohorts over the union; without an id the same read counts twice, and k≥5 can be met by four reads plus a duplicate. Field-equality dedup is not available: two people with identical five-field reads are legitimately two cohort members and *must not* be merged, while one read present in both stores *must* be. Only an id distinguishes these cases.
2. **Deletion.** §7 requires "a relay purge for the same read" alongside `DELETE /v1/memories/{id}` — purge keyed on what? The XTrace memory id doesn't exist client-side for an un-settled read and the relay never learns it.
3. **Verify-and-retry.** The loop must know *which* read to poll for and *which* relay entry to drop. "A read like this one" is not a key.

**Fix:** restore plan v1.0's `Lesson.id` — a client-minted random UUID at approval time, carried in the relay entry and embedded in the pool record content; no account linkage, so the [E9]/[E19] posture is untouched. Dedup, purge, and verify all key on it. One field, one paragraph in §7, and the [E19] CI assertion extends to "exactly these six fields."

### F2 — the verify loop needs an owner and a death story (spec gap, high)

§6 says relay entries are dropped "once [E15]'s verification confirms the read is retrievable," and §6 claims the relay is "bounded by construction." Both statements assume the verify loop always completes — but the loop presumably runs in the authoring device's SPA session, and a judge who confesses and pockets their phone kills it. Consequences as specced: the relay entry is never dropped (the bound breaks — mildly), and on the 11/16 retention path **re-ingest never happens** — the read is lost while the UI already claimed it pooled (the exact [E12] failure this machinery exists to prevent).

**Fix, cheapest first:** verification doesn't need to be the author's job — any client can check whether a relay entry is retrievable from XTrace, and the relay's five fields are sufficient to *reconstruct the pool-scope record* for re-ingest. So: (a) The Pass runs a settle-sweeper over relay entries older than the settle window — verify, re-ingest, or drop; (b) name in §6 that the relay doubles as the pool-scope re-ingest source, which is a genuinely nice property v0.7 already has and doesn't claim; (c) explicitly choose **verified-drop over TTL** — a TTL that expires an unverified entry reintroduces silent loss; surface stuck-entry age in The Pass instead. Note the asymmetry honestly: the *user-scope* prose has no relay copy, so its verify-and-retry needs the prose retained client-side until confirmed — one sentence in §6, and it dies with the session, which is acceptable for the personal tier and should be said.

### F3 — cohort counts over top-k retrieval can undercount, which kills the peak in the other direction (high)

§8 computes cohort counts "over the returned reads plus the relay." XTrace retrieval is top-k with reserved episode slots (§6) — nothing guarantees the returned set contains *every* cohort member. An undercount fails the k≥5 floor for a cohort that actually qualifies: safe for privacy (never over-cites), fatal for the demo (the "six strong" line renders as a cohort-miss). v0.6/v0.7 inherit v1.0's assumption of an exhaustive `all()` that the XTrace substrate doesn't obviously provide.

**Fix:** specify the counting query. Either (a) per-driver scoped retrieval with k comfortably above the largest seeded cohort, (b) authoritative counts maintained in The Pass from the seed manifest plus relay contents (the demo path — counts are then exact by construction), or (c) an XTrace listing endpoint if one exists. Pick one in §8; the near-tie invariant test should assert against whichever is chosen.

### F4 — gate zero needs a pass criterion; one trial of a non-deterministic failure is noise (medium, quick)

§11 says run it, and [E15] says twenty minutes. But retention is 11/16 *non-deterministic* — a single re-ingest trial that happens to succeed proves nothing. Proposed protocol, ~40 minutes wall-clock: seed N=12 fresh reads to a scratch scope; poll each to retrievable or 2× settle window; re-ingest any dropped read, up to two rounds; **pass = all 12 retrievable within two rounds**, recording the rounds distribution; while there, exercise `DELETE` + verify-gone once, since §7's deletion promise is equally untested. Write the criterion into §11 so "ran gate zero" is falsifiable.

### F5 — off-limits and chip strikes gate the pool write; nothing gates the user-scope prose (medium)

§5/§9 enforce off-limits "at the chip screen, upstream of the pool and the relay alike" — but the *prose* is ingested to user scope as-is [E11], and XTrace's extraction doesn't know about struck chips. Two consequences: an off-limits topic blocked from the pool can still enter **user memory** via prose extraction, contradicting §9's "stops user memory from recording it"; and a struck chip's content survives in the personal tier, where The Usual is induced from it. The first is a real §9 violation; the second is defensible (struck = "don't share," not "don't remember for me") but should be a stated decision, not an accident. **Fix:** an off-limits hit blocks *both* writes (the flagged confession is never ingested anywhere), stated in §9; extend the propagation test to assert zero new *user-scope* records for a flagged topic, not just zero pool reads.

### F6 — the [E19] assertion should be a schema allowlist, not narrative detection (low-medium)

"Any request… carrying narrative text… fails the build" is unfalsifiable as written — CI can't recognize "narrative." Invert it: the interceptor asserts every pool/relay write body is *exactly* the read schema (the six fields of F1, enum vocabulary, `additionalProperties: false` semantics) and fails anything else. Reject-by-construction is testable; detect-prose is vibes.

### F7 — the relay's `?since=` is a timing side-channel the pool never had (low, note for [prod])

v1.0 deliberately kept day-precision `createdAt` "no timestamps that fingerprint." The relay reintroduces fine-grained arrival ordering on identity-free reads for the settle window — anyone reading the relay can correlate "a read arrived at 14:32:05" with whoever just visibly confessed. Contents are a subset of the pool and the window is minutes, so this is acceptable for the slice — but §7's honesty pattern suggests saying it, and [prod]'s "relay hardens or disappears" (§6) should list coarse timestamps/opaque cursors if it hardens.

### F8 — consent copy should disclose the prose upload (low, in-product copy)

The chip screen frames the five chips as "what will be shared." Under [E9] the *prose* also leaves the device — to XTrace user scope, held by Confit. That's the design, and §1's wedge survives it; but the confess screen's copy should say both halves plainly ("your words go to your private Confit memory; only these five fields go to the pot"), or the chip screen implies a boundary the architecture no longer has. One sentence in §5; §13's deletion-copy question is the natural place to also settle this wording.

## 3. What this means for the build

Nothing above reopens [E9], [E14], or the verdict. Sequencing: **F1–F3 belong in the frozen contracts** (the read type gains `id`; the pool adapter's counting query gets specified; the relay lifecycle gets an owner) — land them either as a v0.8 edit or directly as contract text in implementation plan v2.0, whichever is less ceremony, but before the freeze. F4 blocks build day (it *is* gate zero, made falsifiable). F5–F6 are first-commit guard specs. F7–F8 are one-line honesty patches in the doc's own style.

*Bottom line: v0.7 closed the gap it set out to close and did the bookkeeping faithfully. The remaining work is giving the relay's machinery the identities and owners it implicitly assumes — after that, freeze contracts and cut tasks.*
