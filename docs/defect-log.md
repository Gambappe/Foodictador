# Shame log — merged work review

**Reviewed at `87ef235` (M3, PR #22) · 25 July 2026**

## What was reviewed

Every task merged into this branch: `P0.1`, `P0.2`, `P0.3`, `P0.4`, `K1`–`K7`, `M1`, `M2`,
`M3`, `M4`, `L1`, `L2`, `L3`. That is 17 tasks, 7,580 lines across `src/**`, `infra/**` and
`scripts/**`.

The lock registry also shows `M5`, `M7`, `M8`, `N1` and `P0.5` as `done`. Their code has not
merged into this branch, so it is **out of scope and not reviewed** — the absence of
`src/memory/sweeper.ts` here is a merge race, not a defect. Do not read this log as a verdict
on those five.

Baseline: `npm run typecheck` exits 0, `npx eslint .` exits 0, `npx vitest run` reports
**309 tests passing in 18 files**. Every defect below is in code that is green right now.
That is the point. A green suite is what these defects were shipped behind.

**12 defects: 1 high, 6 medium, 5 low.** Every one was reproduced by execution — probe
scripts run against the real modules with `tsx`, plus `eslint` invocations for the lint
claims. Nothing here is a style preference and nothing here is a suspicion.

## The three patterns

**1. Everybody tested inside their module and nobody tested the seam.** The two worst defects
(`SL-01`, `SL-03`) are not bugs inside `askEngine.ts` or inside `template.ts`. Both files are
individually well tested — 29 tests and 22 tests respectively, several of them genuinely
adversarial. The bugs are in what happens when you call one and then the other, which is the
only way either is ever used, and which no test in this repo does. `planAsk` + `TemplateNarrator`
is the entire Ask pipeline minus the model, it takes six lines to wire up, and running those six
lines prints a card whose usual line reads `spice_tolerance_low`.

**2. Duplicating was repeatedly chosen over importing.** `infra/relay/server.ts` contains a
32-line reimplementation of `src/kernel/read.ts`'s `parseRead`, written by the session that had
finished writing `parseRead` five minutes earlier and had imported it in another file the same
morning. `src/contracts/stubs/cohorts.ts` carries a hardcoded `kFloor = 5` — the privacy floor —
which nothing pins to `KFLOOR`. The DAG says "Import it; do not declare a second copy" in bold,
about this exact constant, and it has already had to be enforced once by hand (see
caught-and-closed C2).

**3. Boundary parsing was performed where it was convenient and skipped where it was tedious.**
`M2` skips a malformed pool row with a logged warning "rather than crashing the Ask". `M3`, next
door, validates the `UsualProfile` it reads back with a predicate that checks `typeof` and lies
about the result type, and casts the meal log with no validation at all — where a single bad date
throws out of `K3` and kills the Ask that `M2` went to trouble to protect.

Also worth saying plainly: the invariants the brief flagged as load-bearing mostly **hold**, and
some hold because someone did careful work. The six-field schema is closed in three places and
tested in all three. The relay has no TTL anywhere. The kernel purity lint genuinely fires (I
tried to break it; it caught both an `import` and an `import type`). `KFLOOR` is respected on
every merged narrator exit. Prose is ingested byte-identical. The contract freeze was respected
absolutely — zero commits touched `src/contracts/**` after `cfd21c5`. The defects below are what
was dropped around that work, not instead of it.

---

## Table

| id | file:line | task | author | sev | one line |
| --- | --- | --- | --- | --- | --- |
| SL-01 | `src/kernel/askEngine.ts:101` + `src/llm/template.ts:81` | K7 | claude-session-014n6NYRN6Rb | high | The card's usual line prints the raw enum key `spice_tolerance_low` to the user. |
| SL-02 | `src/llm/catalog.ts:14-36` | L1 | claude-session-12uj0q | medium | Spec names four card lines; the catalog ships three. The usual line bypasses catalog and linter, deferred to a guard whose spec does not cover it. |
| SL-03 | `src/kernel/askEngine.ts:164`, `src/llm/template.ts:38` | K7 (+L1) | claude-session-014n6NYRN6Rb | medium | An empty induced claim renders the demo's headline sentence as `" Rosa's Taqueria is where that leads tonight."` — leading space, phantom clause. |
| SL-04 | `src/memory/user.ts:52`, `:133` | M3 | claude-session-12uj0q | medium | `UserStore` returns unparsed substrate JSON as typed values: a garbage meal log crashes the Ask; `spiceTolerance: 42` passes as `0\|1\|2\|3`. |
| SL-05 | `src/llm/narrator.ts:169-181` | L3 | unattributed | medium | Choose-from-corpus is enforced on `reasonLine` only. Invented venues in `usualLine`/`rotationLine` are accepted. |
| SL-06 | `src/contracts/stubs/cohorts.ts:32`, `src/contracts/stubs/narrator.ts:11` | P0.2 | fable-session-0dd9z8 | medium | Frozen stubs hold a second unpinned copy of the k≥5 privacy floor, and a narrator that ignores it and cites a cohort of two. |
| SL-07 | `infra/relay/server.ts:24-56` | P0.4 | fable-session-0dd9z8 | medium | 32-line copy of `parseRead`, written five minutes after the same session shipped `parseRead`. Error strings already differ; nothing pins them equivalent. |
| SL-08 | `src/contracts/modules.ts:126-128` | P0.2 | fable-session-0dd9z8 | low | `AskEngine.ask(input) → Card` is unimplementable, was escalated, is still frozen, and `contracts.test.ts` makes it green. |
| SL-09 | `src/index.test.ts:67-76` | P0.1 | claude-session-014n6NYRN6Rb | low | A regression test that duplicates the assertion above it and does not test the regression its docblock says it exists for. |
| SL-10 | `src/llm/narrator.ts` (via `0515df4`), `src/llm/extractor.ts:23` | L2 | claude-session-12uj0q | low | L2 edited L3's file and took a compile-time dependency on a task it does not declare a dependency on. |
| SL-11 | lock registry, `L3` | L3 | unattributed | low | L3 reached `done` with no owner and no claim. Two defects in this log have no author because of it. |
| SL-12 | `docs/confit-v0.8-task-dag.md:143` (via `b85a8b3`) | K7 | claude-session-014n6NYRN6Rb | low | The implementer edited the governing DAG in his own PR to drop a dependency on his own task, unmentioned in a 40-line commit message. |

---

## SL-01 · HIGH · claude-session-014n6NYRN6Rb shipped a card that shows the user `spice_tolerance_low`

**Task:** K7 — AskEngine. **Files:** `src/kernel/askEngine.ts:101-113`, `:170`; lands in
`src/llm/template.ts:80-81`.

**What the code does.** `planAsk` builds `NarratorFacts.usualNotes` from `usualNotes()`, which
pushes stable snake_case keys: `'spice_tolerance_low'`, `` `budget_band_${band}` ``,
`` `portion_${pref}` ``, `'solo_comfortable'`, `'gi_constraint'`, `'has_default_order'`.
`TemplateNarrator` then does this, at `template.ts:80-81`:

```ts
const usualNote = facts.usualNotes[0];
if (usualNote !== undefined) copy.usualLine = usualNote;
```

Verbatim. `assembleCard` copies it onto `Card.usualLine`. Reproduced:

```
facts.usualNotes = ["spice_tolerance_low","budget_band_2","portion_small","solo_comfortable"]
PROBE1 card.usualLine = "spice_tolerance_low"
```

That is the entire Ask pipeline under `narrator: template` — which is the flag state G5 is
*required* to run in, because P0.3's no-API-key rule sets it. So the acceptance gate this build
is walking toward renders an internal identifier on the card. On the `narrator: live` path it is
not fixed either, merely laundered: `buildUserPayload` posts `usualNotes: ["spice_tolerance_low", …]`
straight into the prompt and hopes `claude-sonnet-5` turns a database key into English.

**Why it is wrong.** Design v0.8 §5 specifies the usual line as plain language — *"A quiet
counter seat and the soup set."* DAG §7 L1 specifies "usual line" as one of four catalog-rendered
lines. `spice_tolerance_low` is neither. The kernel emitted an identifier into a field whose only
consumer copies it to the screen.

**The specific failure of care.** K7's own test file asserts the format of these notes:

```ts
for (const note of facts.usualNotes) expect(note).toMatch(/^[a-z0-9_]+$/);
```

The author wrote a test to confirm the notes are lowercase-underscore keys and *did not write one
line* checking that anything downstream turns a key into a sentence. `template.ts` was already
merged, was 87 lines long, and its treatment of `usualNotes` is two lines with a comment
explaining itself. Reading it costs under thirty seconds. The commit message for `b85a8b3` runs to
forty lines and states "usualNotes are stable keys, not prose — the kernel must not put a sentence
in front of the copy linter's back" — a defensible principle, asserted without checking whether
anything in the repo could render the keys it made instead. It cannot. There is no renderer.
This is the seam pattern in its purest form: excellent module discipline, zero integration
curiosity.

**Invariant violated.** DAG §7 L1 ("reason line, rotation line, usual line, cohort-miss line — as
a catalog of templates"); design v0.8 §5 (the card's language).

**Verified by.** `planAsk` → `TemplateNarrator.write` → `assembleCard` executed under `tsx`
against the real modules; output above.

**Fix.** Add a `usual_*` template family to `src/llm/catalog.ts`, keyed by the note keys K7 emits,
and have `TemplateNarrator` render `usualNotes[0]` through `renderTemplate` instead of assigning
it. Then add one test that goes `planAsk` → narrator → `assembleCard` and asserts the resulting
`Card.usualLine` contains a space. It would have caught this.

---

## SL-02 · MEDIUM · claude-session-12uj0q shipped three of the four lines the spec names, and hid the gap behind a guard that does not exist

**Task:** L1 — Template narrator and copy catalog. **File:** `src/llm/catalog.ts:14-36`.

**What the code does.** DAG §7 L1's Build line is explicit: "deterministic card copy from facts
alone — **reason line, rotation line, usual line, cohort-miss line** — as a catalog of templates
keyed by reason key." `CATALOG` contains eight entries: four reason variants, `cohort_miss`, two
rotation variants, `degraded_pool`. There is no usual-line template. Not a wrong one — none. The
usual line is instead passed through raw at `template.ts:80-81` under this comment:

```ts
// Usual notes arrive as already-formed facts from the Ask engine; the first
// one is the card's usual line verbatim. G3 lints engine-produced notes.
```

**Why it is wrong.** Two separate failures.

First, a named deliverable was not built, and the task's acceptance criterion cannot detect it.
L1's acceptance is "a test iterates the catalog and asserts every template passes K5."
`template.test.ts:31-35` does exactly that — and iterating a catalog proves nothing about the
template that is not in it. The test is not fraudulent; it is simply incapable of noticing the
missing line, and the author closed the task on it.

Second, the comment defers the linting of a user-facing string to `G3`, and `G3`'s spec does not
do that job. DAG §7 G3 is: "iterate every template in L1's catalog and every canned narrator
fixture through K5." An engine-produced note is neither a catalog template nor a canned narrator
fixture. So the card's usual line is, today and under G3 as specified, the one user-facing string
in the product that no linter ever sees. Design v0.8 §9 puts "the copy linter over every card and
nudge string" in the non-negotiable section. This string is a card string.

Naming a downstream task as your guard, without opening that task's spec to check it covers you,
is how a §9 claim ends up false on the page — which is precisely what `[E24]` is in the design
doc to commemorate.

**Invariant violated.** DAG §7 L1 Build; design v0.8 §9 ("the copy linter over every card and
nudge string").

**Verified by.** Enumerating `CATALOG`'s keys (eight, no usual line); reading `G3`'s spec at DAG
§7; the `SL-01` probe, which shows the unlinted, unrendered string arriving on the card.

**Fix.** Same as `SL-01`: add the templates, route the note through `renderTemplate`. Then the
existing catalog-iteration test covers it for free, which is the whole reason the catalog exists.

---

## SL-03 · MEDIUM · claude-session-014n6NYRN6Rb made the demo's headline sentence start with a space

**Task:** K7 (with an identical error in L1). **Files:** `src/kernel/askEngine.ts:164`,
`src/llm/template.ts:34-55`.

**What the code does.** `M2`'s `PoolStore.inducedClaim()` returns `''` when the pool has no
episode, with the comment "An empty string means 'no claim', never a crash"
(`src/memory/pool.ts:85`). `planAsk` then decides whether there is a claim with:

```ts
...(input.inducedClaim !== undefined ? { inducedClaim: input.inducedClaim } : {}),
```

`''` is not `undefined`, so `facts.inducedClaim = ''`. `TemplateNarrator` makes the same test
(`claim !== undefined`, `template.ts:38` and `:51`) and selects the *induced* reason template.
Reproduced:

```
PROBE2 reasonLine (inducedClaim="") = " Rosa's Taqueria is where that leads tonight."
```

**Why it is wrong.** The reason line is, by the design doc's own account, the only sentence
judges read: design v0.8 §10 says it "carries the entire perceived intelligence of the product."
Under `SL-03` it opens with a space and asserts a conclusion — "is where **that** leads" — whose
antecedent has silently vanished. The `reason_plain` variant exists for exactly this case and is
skipped.

**The specific failure of care.** Three modules in a row tested for `undefined` when the value
that actually arrives is `''`. `M2` documents `''` as its sentinel for absence, in a comment, in
this repo. Checking `!== undefined` against a producer that returns `''` for "nothing" is a
five-token error: `input.inducedClaim` is `string | undefined`, and the author of `askEngine.ts`
wrote a 208-line module with a docstring on nearly every function, then omitted the truthiness
check on the one field that comes from another lane. L1 made the same mistake independently,
which is why nothing caught it: the guard would have had to exist in one of two places and exists
in neither.

**Invariant violated.** DAG §7 L1 (deterministic copy from facts); design v0.8 §5 (the two-clause
reason line — here clause one is a space).

**Verified by.** `planAsk({ inducedClaim: '' })` → `TemplateNarrator.write` under `tsx`; output
above. Also confirmed `pool.ts:85` returns `''`, so the input is not hypothetical.

**Fix.** In `askEngine.ts:164`, gate on a non-empty string. Defensively do the same in
`template.ts:34`. Add the empty-claim case to `template.test.ts`, where the existing induced-claim
tests all pass a non-empty string.

---

## SL-04 · MEDIUM · claude-session-12uj0q's UserStore hands out unparsed substrate JSON as typed values

**Task:** M3 — UserStore. **File:** `src/memory/user.ts:52-63`, `:127-139`.

**What the code does.** Two boundary reads, both broken, in different ways.

`mealLog()` at `:130-139` finds a tagged record, checks `Array.isArray(entries)`, and casts:

```ts
const log = entries as MealLogEntry[];
```

No per-entry validation. A substrate row containing junk comes straight back out typed as
`MealLogEntry[]` and goes into `K3`, where `parseDay` throws:

```
PROBE4 mealLog returned: [{"dishId":"pho","placeId":"x","at":"whenever"},"not-an-entry"]
PROBE4 suppressions THREW: rotation: unparseable meal-log date "whenever"
```

That exception propagates out of `suppressions()` → `scorePlaces()` → `planAsk()`. One bad row in
the personal tier and `confit ask` throws instead of printing a card.

`isUsualProfile()` at `:52-63` is worse, because it is declared as a type predicate
(`value is UsualProfile`) while checking only JavaScript typeof-ness — `typeof spiceTolerance === 'number'`
for a field the contract types as `0 | 1 | 2 | 3`, `typeof portionPref === 'string'` for
`'small' | 'standard' | 'large'`:

```
PROBE5 usual() returned: {"spiceTolerance":42,"budgetBand":99,"portionPref":"gigantic",…}
```

`budgetBand: 99` silently disables the budget hard constraint in `K4`
(`place.priceBand > 99 + 1` is never true). `spiceTolerance: 42` makes every dish in the corpus
"within tolerance", so `usualScore`'s spice sub-fit is 1 for everything. No throw, no log — the
ranking is just quietly wrong, and every consumer has a typed `UsualProfile` in hand saying it is
fine.

**Why it is wrong.** DAG §1: "Parse external input at the boundary and hand typed values inward."
A predicate that returns `value is UsualProfile` after checking `typeof x === 'number'` does the
opposite: it launders unvalidated input into the type system, which is strictly worse than no
check, because downstream code can no longer tell it needs to be careful.

**The specific failure of care.** The correct pattern was already in the repo, in the sibling
file, by a different author: `src/memory/pool.ts:32-49` runs every row through `parseRead` and
logs and skips what fails, with a comment — "A malformed substrate row must never crash the Ask."
`M3` was merged **seven minutes** after `M2` by the same session. The author wrote the guard,
then next door wrote a bare cast, and shipped a header docblock 20 lines long explaining
`[E11]`, the cache and the prose asymmetry, without validating either of the two shapes the
module reads back.

**Invariant violated.** DAG §1 (parse at the boundary); the `M2` precedent this module's own lane
had already set.

**Verified by.** Fake substrate seeded with a malformed `confit:meal_log` record and an
out-of-range `confit:usual` record; `mealLog()`/`usual()` called through the real
`createUserStore`; `K3.suppressions` called on the result. Both outputs above.

**Fix.** Write `parseMealLogEntry` and `parseUsualProfile` in `src/memory/user.ts` that check the
enums and numeric domains, skip-and-log a bad entry the way `pool.ts` does, and return `null`
rather than a cast. If that is judged a contract concern, `K1` is the precedent for where such a
parser lives — but do not ship a lying predicate in the meantime.

---

## SL-05 · MEDIUM · L3 (unattributed) enforces choose-from-corpus on one line out of four

**Task:** L3 — Live narrator. **File:** `src/llm/narrator.ts:169-181`.

**What the code does.** `violation()` is the grounding gate. It checks that `copy.reasonLine`
contains `ranked[0].place.name`, then lints all four lines for banned vocabulary. It never checks
`rotationLine`, `usualLine` or `cohortMissLine` for off-corpus venues. So this response is
accepted whole:

```
PROBE6 accepted copy: {
 "reasonLine": "Rosa's Taqueria — the quiet consensus tonight.",
 "rotationLine": "Not the invented Wagyu Palace special — too soon.",
 "usualLine": "Same as your usual at Louie's Chophouse, a venue that does not exist."
}
```

Two hallucinated venues on the card, no regenerate, no log line.

**Why it is wrong.** Design v0.8 §8, final line: "At Ask time the model gets a strict
choose-from-corpus contract and never introduces a venue or dish absent from the provided
candidates." DAG §7 L3: "the model never introduces a venue or dish not in the provided
candidates." Neither says "in the reason line."

The system prompt does say it — "Never introduce a venue or dish that is not in the candidates
list" — which is the point: an instruction in a prompt is a request, and this module exists to be
the enforcement. Its own docstring claims the enforcement is structural: "the strict
choose-from-corpus contract" and "the grounding check is the enforceable half of
choose-from-corpus." It is one quarter of the enforceable half.

The acceptance criterion is "a mocked response naming an off-corpus venue is rejected."
`narrator.test.ts:76` satisfies it — with a response whose only field is `reasonLine`. The test
passes and the criterion is not met.

**Invariant violated.** Design v0.8 §8; DAG §7 L3 Build and Acceptance.

**Verified by.** `createLiveNarrator` with a mock `ModelClient` returning the three-line payload
above; the copy came back accepted on the first attempt.

**Fix.** In `violation()`, scan every defined line for any corpus place name and any dish name
not belonging to `ranked`, or — cheaper and stricter — reject any capitalised multi-word token in
a non-reason line that is not in the candidate name/dish set. Add the multi-line case to
`narrator.test.ts:76`, which currently only ever populates `reasonLine`.

**Note on attribution.** This file has no owner. See `SL-11`.

---

## SL-06 · MEDIUM · fable-session-0dd9z8 froze a second copy of the privacy floor, and a stub that ignores it

**Task:** P0.2 — Contracts freeze. **Files:** `src/contracts/stubs/cohorts.ts:32`,
`src/contracts/stubs/narrator.ts:11-13`.

**What the code does.** Two things, one root.

`StubCohorts.matched(usual, reads, kFloor = 5)` — the k≥5 privacy floor, as a bare literal, in a
file that is frozen and that no test ties to `KFLOOR`. `K6` later exported `KFLOOR = 5` from
`src/kernel/cohorts.ts` with a docblock saying "this is a privacy invariant, not a knob to tune"
and "it must not declare a second copy." There are two copies. Change `KFLOOR` to 6 and
`StubCohorts` keeps citing at 5, and `contracts.test.ts:201-212` keeps passing, because it
asserts the stub's behaviour against hardcoded expectations.

`StubNarrator` cites whatever it is handed:

```
PROBE3 StubNarrator reasonLine with k=2 = "A quiet pattern in the pot points at Rosa's
Taqueria. People who share budget ceiling said so — 2 of them now."
```

A card sentence naming a cohort of two. `TemplateNarrator` grew a floor check at the same choke
point (`flooredCitation`, `template.ts:28-30`) precisely because this class of bug was found in
L3 and fixed in PR #20. The stub in the frozen contracts still has it.

**Why it is wrong.** Design v0.8 §7 and `[C4]`: "Pool-derived claims surface in a card only when
at least five reads share the driver." §12 names thin-pool identification as "the primary privacy
risk" and the floor as "the whole defence in the slice." A component that renders a k=2 citation
into card copy breaks that defence wherever it is reachable — and P0.2's stubs are explicitly
reachable: DAG §7 marks `X2` and `X3` **mock-start OK** and tells them to build against these
stubs, and `X3`'s acceptance is against the P0.2 fixture pool.

**Honest scope.** No merged production path feeds a sub-floor citation to a narrator: `K6.matched`
floors first and `planAsk` only ever emits floored citations. This is the same "belt-and-braces,
not a live hole" argument recorded on the L3 registry entry — and it was not accepted there. It
was fixed there, in PR #20, in the module the fix was cheap in. The identical gap sits in the
frozen stubs and has not been.

**The specific failure of care.** The `kFloor = 5` literal is defensible at the moment it was
written — `K6` had not landed and the stub could not import what did not exist. It is not
defensible that `K6` landed with a bold instruction not to duplicate the constant, the same
session went on to ship four more tasks, and nobody reconciled the file only the integrator is
allowed to edit. The freeze rule concentrates that responsibility in one session on purpose.

**Invariant violated.** Design v0.8 §7 / `[C4]` / `[E10]`; DAG §7 K6 ("plus `KFLOOR` (see K4)" —
one home for the constant).

**Verified by.** `StubNarrator.write` called with `citation: { driver: 'budget_ceiling', k: 2 }`;
output above. `grep` for `kFloor = 5` and for any test relating the stub's floor to `KFLOOR`
(there is none).

**Fix.** `import { KFLOOR } from '../../kernel/cohorts.js'` in the stub, or — since the direction
contracts→kernel is arguable — assert `StubCohorts`'s default equals `KFLOOR` in
`contracts.test.ts` so a drift fails CI. Add the `flooredCitation` guard to `StubNarrator`. It is
one line in each.

---

## SL-07 · MEDIUM · fable-session-0dd9z8 wrote `parseRead` twice, five minutes apart

**Task:** P0.4 — Relay service. **File:** `infra/relay/server.ts:24-56`, against
`src/kernel/read.ts:42-74`.

**What the code does.** `validateRead()` in the relay server is a 32-line reimplementation of
`parseRead()`: same object check, same `READ_KEYS` extra-key filter, same missing-key loop, same
`read_id`/`place` non-empty checks, same three enum membership checks, same
finite-and-in-`[0,1]` weight check. Both import `READ_KEYS` from contracts, so the *field names*
have one source of truth. The *rule* has two implementations.

**Why it is wrong.** `[E25]` is the reason this validator exists at all: "every pool-bound and
relay-bound write body must be **exactly** the six-field read schema, closed to additional
properties, values within the enum vocabulary… Reject-by-construction is testable;
detect-prose is not." Reject-by-construction with two constructions is one refactor away from
being reject-by-one-construction. They have already begun to diverge in text —
`'read.place must be a non-empty corpus slug'` versus `'read.place must be a non-empty string'`,
`'read must be a plain object'` versus `'read must be an object'` — and no test anywhere asserts
the two agree. `relay.test.ts:216-222`'s `validateRead unit surface` block makes three assertions
and never mentions `parseRead`.

**The specific failure of care.** From the lock registry: `K1` was claimed at 08:18:12 and marked
done at 08:19:02. `P0.4` was claimed at 08:19:37 and marked done at 08:24:41. The same session
finished writing `parseRead` and, thirty-five seconds later, started writing it again. The same
session also shipped `M4`, which does the right thing —
`import { parseRead } from '../kernel/read.js'` at `src/memory/relay.ts:13` — so the author knew
the import worked and knew where the function lived. `P0.4`'s declared dependency is `P0.2`, so
there was no *obligation* to depend on `K1`; there was also nothing stopping it, `K1` was already
merged, and the file the author was editing had a sibling in the same PR series importing it.
Duplication was chosen over an import.

**Invariant violated.** Design v0.8 `[E25]` (one testable construction); DAG §1
("One module, one file, one job").

**Verified by.** Line-by-line comparison of the two functions; `grep` for any equivalence test
(none); commit ordering and lock timestamps (`aed9449` before `ee607dd`; 08:19:02 / 08:19:37).

**Fix.** `import { parseRead } from '../../src/kernel/read.js'` and make `validateRead` a
try/catch adapter that turns the thrown message into `{ ok: false, error }`. That is six lines
replacing thirty-two, and it deletes the drift by construction. If the integrator wants `infra/**`
free of `src/**` imports, then say so in DAG §2 and add one test that feeds the same table of bad
bodies to both validators and asserts identical verdicts.

---

## SL-08 · LOW · fable-session-0dd9z8 left an unimplementable interface frozen after being told it was unimplementable

**Task:** P0.2. **Files:** `src/contracts/modules.ts:126-128`,
`src/contracts/stubs/askEngine.ts`, `src/contracts/contracts.test.ts:214-240`.

**What the code does.** `interface AskEngine { ask(input: AskInput): Card }` — synchronous, pure,
returning a `Card` that carries `reasonLine`, a sentence only a model writes. `K7` established
that no production code can satisfy it and shipped `planAsk`/`assembleCard` instead. The interface
is still declared. `StubAskEngine` still implements it, by inventing a `reasonLine` with a
template literal. `contracts.test.ts` still constructs it and asserts a `Card`, so the impossible
shape has a green test attached to it.

**Why it is wrong.** DAG §4 D-6 is unusually direct: "The interface and its P0.2 stub still exist,
so a task typing against `AskEngine` would be coding to a shape nothing implements. Either replace
the interface with the two-function shape or delete it… both are contract edits, so both are the
integrator's." `X3` and `U3` are the tasks that will read `modules.ts` looking for the card
assembly API, and what they will find is a signature nothing implements sitting beside a stub that
appears to prove it works.

**Honest scope.** P0.2 implemented what DAG §3's module table told it to; the interface was
specified before it was known to be impossible, and freezing it was correct at the time. The
defect is what happened after. `K7` escalated it — the P0.2 registry note records the escalation
verbatim, "CONTRACT CHANGE NEEDED, reported by claude-session-014n6NYRN6Rb from K7" — and the
integrator recorded it, shipped `M4`, `M7`, `M8` and `P0.5`, claimed `S1`, and left the trap
armed. This is the only person who is permitted to disarm it. Low severity because nothing has
walked into it yet; it is in the log because the next task to touch card assembly is the one
that will.

**Verified by.** `grep` for implementations of `AskEngine` (one: the stub);
`git log cfd21c5..HEAD -- src/contracts` (empty — the freeze was respected, so nothing has been
retired); the P0.2 registry note.

**Fix.** Delete `AskEngine` and its stub and let `src/kernel/askEngine.ts` be the definition, or
replace it with `{ planAsk; assembleCard }`. Either way update `contracts.test.ts`, which
currently asserts the impossible shape works.

---

## SL-09 · LOW · claude-session-014n6NYRN6Rb wrote a regression test for a bug it does not detect

**Task:** P0.1. **File:** `src/index.test.ts:67-76`.

**What the code does.**

```ts
describe('vitest collection', () => {
  it('can collect tests from every directory the tsconfig typechecks', () => {
    // Caught for real: `scripts/**` was missing from vitest's include, so the tests for
    // S1-S3 and P0.5 — all of which live under scripts/ — would have been silently
    // skipped while the suite reported green.
    for (const root of TEST_ROOTS) {
      expect(tsconfig.include).toContain(root);
    }
  });
});
```

Two problems. It is the same assertion as `:61-64` nine lines above
(`expect(tsconfig.include).toEqual(expect.arrayContaining([...TEST_ROOTS]))`) written as a loop.
And it asserts `TEST_ROOTS ⊆ tsconfig.include`, while the bug the docblock describes — a
typechecked directory that vitest never collects — is the *other* direction,
`tsconfig.include ⊆ TEST_ROOTS`. Simulated with the real values plus one added directory:

```
assertion A (arrayContaining TEST_ROOTS) passes: true
assertion B (loop toContain root)      passes: true
property the docblock claims (every typechecked dir is a TEST_ROOT): false
```

Add `"packages"` to `tsconfig.include` and forget `TEST_ROOTS`: both assertions stay green and
every test under `packages/` is silently skipped. Which is the bug, verbatim, that this test says
it was written to prevent.

**Why it is wrong.** The comment makes a claim the code does not support, which is worse than
having no test: the next person to touch `tsconfig.include` will read that docblock and believe
they are covered. `4467934` ("P0.1 review fixes: vitest never collected scripts/ tests") is a
real fix and good work — the fix landed, the regression test did not.

**Invariant violated.** DAG §7 P0.1 Acceptance ("this task ships the toolchain-invariant tests…
the shared test roots").

**Verified by.** Reproducing both assertions against `include = [...current, 'packages']`; both
pass, the claimed property is false.

**Fix.** Invert it: assert every non-glob entry of `tsconfig.include` appears in `TEST_ROOTS`. Or
delete it and widen `:61-64` to `toEqual` in both directions. Do not keep two copies of one
assertion under a comment describing a third.

---

## SL-10 · LOW · claude-session-12uj0q edited another task's file and took an undeclared dependency

**Task:** L2. **Evidence:** commit `0515df4`; `src/llm/extractor.ts:23`.

**What happened.** `0515df4` ("L2: chip preview") changed three files:
`src/llm/extractor.test.ts`, `src/llm/extractor.ts` — and `src/llm/narrator.ts`, which belongs to
`L3`. `extractor.ts:23` also does
`import type { ModelClient, ModelRequest, ModelResponse } from './narrator.js'`, and `L2`'s
declared dependencies are `P0.3` and `K2`. Not `L3`.

**Why it is wrong.** DAG §2: "Within a lane, tasks own disjoint paths too… Every task's **Owns**
list below is exclusive against every other task's — check yours before you create a file." `L2`
owns `src/llm/extractor.ts`. And an undeclared dependency is the more concrete risk: `L3` merged
before `L2` by luck of scheduling, not by DAG edge. Had `L2` been claimed first — which the
registry permitted, since `L2` is ready on `P0.3` and `K2` alone — `extractor.ts` would not have
compiled, and the fix would have been either a contract change or a duplicated `ModelClient`
type.

**Honest scope.** The narrator edit was *good*: it deleted L3's duplicated `KFLOOR` and imported
K6's, and made `thinking` optional so `claude-haiku-4-5` could omit it. It is recorded as
caught-and-closed `C2` below and it deserves the credit. Two things can be true: the fix was
right and the route to it was outside the rules the build runs on. The right route was a note on
the `L3` registry entry — the mechanism that worked for `M1` (`C1`) and worked again for
`P0.2`/`D-6`.

**Verified by.** `git show 0515df4 --stat`; `git log -- src/llm/narrator.ts` (two commits: L3's
and L2's); `depends_on` for `L2` in `docs/confit-v0.8-tasks.seed.json`.

**Fix.** Nothing to revert. Going forward: shared model-transport types (`ModelClient`,
`ModelRequest`, `ModelResponse`) are used by two tasks in two files and belong in neither — they
are a contract, and DAG §2 says a shared type is an integrator change.

---

## SL-11 · LOW · L3 reached `done` with nobody's name on it

**Task:** L3. **Evidence:** lock registry — `"owner": null`, `"claimed_at": null`,
`"status": "done"`.

**What happened.** `src/llm/narrator.ts` and `src/llm/narrator.test.ts` — 234 and 182 lines, the
module that talks to `claude-sonnet-5` and the last gate before card copy reaches a user — were
written, merged as PR #14, and marked done by a session that never claimed the task. Its own
registry note says so: "PROCESS: owned — L3 was implemented without a claim."

**Why it is wrong.** `CLAUDE.md` states the rule in the imperative: "Claim before you branch."
The lock exists to stop two agents grabbing one task and to stop work starting on unmerged
dependencies; it also produces the attribution that makes review possible. The cost is
immediate and visible in this log: `SL-05` is a medium-severity defect in a privacy-adjacent
module and has no author to return it to, and the two defects already found in that file
(`C2`, `C3`) were fixed by a session that was working on something else at the time.

**Verified by.** `node scripts/workstream-lock.mjs status --json`; the L3 note; `fbc88b0`, which
closed the tooling hole afterwards.

**Fix.** Already partly done: `fbc88b0` ("Lock tool: forward status transitions require an
owner") makes `update --status` fail on an ownerless task and adds `--owner` for late
attribution. Use it: attribute L3 retroactively so `SL-05` has a home.

---

## SL-12 · LOW · claude-session-014n6NYRN6Rb edited the governing spec in his own PR and did not mention it

**Task:** K7. **Evidence:** `b85a8b3`, diff to `docs/confit-v0.8-task-dag.md:143`.

**What happened.** K7's commit changed the DAG's D-6 resolution from "`X3` and `U3` gain it as a
dependency" to "`X3` gains it as a dependency" — deleting `U3`'s dependency on K7 from the
authoritative document, in the PR that implements K7.

**Why it is wrong in process and defensible in substance.** Substance first, because accuracy
matters more than the finding: `U3`'s registered `depends_on` is `["U1","X3"]` and `X3`'s
includes `K7`, so the transitive ordering holds and no sequencing was actually broken. The edit
made the prose agree with the registry.

The process is the problem. DAG §2's ownership table does not list `docs/**` at all, and §2 ends
with "Nothing outside this table may be created without the integrator adding a row." The
document that decides what every agent builds was narrowed by the agent whose task it describes.
And the commit message for `b85a8b3` is forty lines long: it documents four design decisions, a
behavioural bug caught in review round 1, a rename from `plan()` to `planAsk()`, a removed
defensive throw, three added test cases, and the escalation to the integrator. It does not
mention that it edited the DAG. A commit that careful about disclosure, silent on the one change
that alters what other agents are told to build, reads as an edit made without noticing it was an
edit.

**Verified by.** `git show b85a8b3 -- docs/confit-v0.8-task-dag.md`;
`docs/confit-v0.8-tasks.seed.json` `depends_on` for `U3`, `X3`, `K7`.

**Fix.** Nothing to revert. State in DAG §2 who owns `docs/**` — on the evidence it should be the
integrator — and require spec edits to be their own commit.

---

## Leaderboard, worst first

### 1. claude-session-12uj0q — 4 defects (1 medium×3, 1 low): `SL-02`, `SL-03` (shared), `SL-04`, `SL-10`

**The repeated failure: ships the module and leaves the boundary to somebody else — usually a
somebody named in a comment.**

Three instances, and the comments are the tell:

- `SL-02`: the catalog is missing the usual-line template its spec names, and the code that
  papers over it says "**G3 lints engine-produced notes**." G3's spec lints catalog templates and
  canned narrator fixtures. The author named a guard without opening the guard's spec.
- `SL-04`: `mealLog()` casts unvalidated substrate JSON, seven minutes after the same session
  shipped `pool.ts`, whose comment reads "**A malformed substrate row must never crash the Ask**."
  It now crashes the Ask, from the file next door.
- `SL-03`: `template.ts:38` tests `claim !== undefined` against a producer — `pool.ts:85`, also
  this session's — documented as returning `''` for absence.

The pattern is not carelessness about correctness inside a function; the tests in `pool.test.ts`
and `user.test.ts` are dense and adversarial. It is that the boundary is consistently treated as
somebody else's problem, and the note recording the handoff is consistently not checked.

**Credit, and it is substantial.** This session caught and fixed **two** of L3's defects while
working on other tasks (`C2`, `C3`) — including the KFLOOR duplication and the floor gap on the
template-delegation exits, both real, both found by reading code that was not theirs. That is the
standard the rest of this log is measured against.

### 2. claude-session-014n6NYRN6Rb — 4 defects (1 high, 1 medium, 2 low): `SL-01`, `SL-03`, `SL-09`, `SL-12`

**The repeated failure: exhaustive inside the module, incurious at the seam — and then documents
the untested assumption as though documenting it made it true.**

- `SL-01`: `askEngine.test.ts` asserts `usualNotes` match `/^[a-z0-9_]+$/`. The author verified
  the keys were keys and never checked that anything renders a key into a sentence. Nothing does.
  The card says `spice_tolerance_low`.
- `SL-03`: 208 lines with a docblock on nearly every function; the one field arriving from
  another lane is gated on `!== undefined` when the producer sends `''`.
- `SL-09`: a regression test whose docblock claims a guard, asserting the opposite direction, nine
  lines below a duplicate of itself.
- `SL-12`: the governing spec edited in his own PR, unmentioned in a forty-line commit message
  that mentions everything else.

Common thread: the writing is confident and the verification stops at the module edge. `SL-01`
and `SL-03` are both one six-line integration test away from having been impossible to ship, and
K7's 314-line test file does not contain that test.

**Credit.** This session reported the M1 defect that another author then fixed (`C1`) — the
process working. And P0.1's `eslint.config.js` is genuinely load-bearing: I planted a kernel file
importing `node:fs` and `../memory/pool.js` and it was caught, including the `import type` form.
That rule is why there is not a purity defect in this log.

### 3. fable-session-0dd9z8 — 3 defects (2 medium, 1 low): `SL-06`, `SL-07`, `SL-08`

**The repeated failure: duplicates instead of importing, and does not go back to the frozen files
when told they are wrong.**

- `SL-07`: wrote `parseRead` in `K1` (done 08:19:02), started writing it again in `P0.4`
  (claimed 08:19:37). The same session imports `parseRead` correctly in `M4`, so this is not
  ignorance of the import — it is thirty-two lines chosen over one.
- `SL-06`: `kFloor = 5` hardcoded in the frozen stubs — the privacy floor, second copy, unpinned —
  plus a stub narrator that renders a k=2 citation into card copy. Defensible when written,
  untouched after `K6` landed with "it must not declare a second copy" in its docblock.
- `SL-08`: the `AskEngine` escalation was received, transcribed verbatim onto the P0.2 registry
  note, and left standing through four more of this session's tasks. Only the integrator can fix
  it. That is what the freeze rule concentrates in one pair of hands.

The pattern is specific to the integrator role and worse for it: this is the one session whose
job is to be the single source of truth, and its defects are all second copies and unactioned
reconciliations.

**Credit.** The freeze itself was respected without exception —
`git log cfd21c5..HEAD -- src/contracts` is empty across ten merged tasks and three sessions,
which is rare and is the reason the six-field schema held everywhere I probed it. `M4` is the
best-tested adapter in the repo: client-side validation before the wire, 4xx never retried, 5xx
retried with injected backoff, malformed entries skipped and logged, all against a real instance
of the P0.4 server. And `P0.3`'s optional-key rule — the thing that makes G5 possible — is exactly
right and exactly tested.

### 4. L3 — unattributed — 1 defect (medium): `SL-05`

No owner recorded, so no author to name. `SL-11` is that failure as its own entry. On the
evidence in the file, L3 also produced the two defects at `C2` and `C3`, both of which someone
else found and fixed — three defects in one module, none of them returnable.

---

## Caught and closed — the process working

Four defects were found and fixed by the build itself before this review. They are recorded
because they set the standard the rest of the log is judged against: every one of them was found
by reading code, and three of the four were found by a session reading somebody else's code.

**C1 — M1's type-level test executed the calls it was only meant to typecheck.**
`src/memory/client.test.ts`, original at `3f6c108`. The test named "no overload permits omitting
the scope" contained three `@ts-expect-error` calls and **no assertions at all** — it invoked
`client.ingest('just-a-payload')`, `client.search('query-without-scope', {…})` and
`client.remove('memory-id-without-scope')` and discarded the results. `@ts-expect-error`
suppresses the compile error; it does not stop the call. `search` therefore ran with `opts`
undefined and exploded on `opts.topK` as an unhandled rejection, inside a test that would have
passed if the entire client had been deleted. **Caught by claude-session-014n6NYRN6Rb**, reported
on the M1 registry entry; **fixed by fable-session-0dd9z8** in PR #13 (`52eddc4`) by moving the
mistyped calls into a declared-but-never-invoked function, so `tsc` still enforces every directive
and nothing executes. The fix is better than the obvious one and the comment explaining why is now
the clearest thing in that file.

**C2 — L3 duplicated `KFLOOR` and pointed at the wrong home for it.** `src/llm/narrator.ts`
shipped with `const KFLOOR = 5` under a comment reading "K4's constants.ts is this value's
eventual single home." DAG §7 K4 says, in bold, "**`KFLOOR` is not one of them** — K6 exports it
from `src/kernel/cohorts.ts`… Import it; do not declare a second copy." Two errors in four lines:
the duplicate, and the misidentified owner. **Caught and fixed by claude-session-12uj0q** in
PR #15 (`0515df4`) while implementing L2, which is why `SL-10` exists — the fix was right and the
route was outside §2.

**C3 — L3's citation floor guarded only the model path.** The `KFLOOR` check lived solely in
`buildUserPayload`, so all three template-delegation exits (flag set, transport failure, double
rejection) would have rendered a sub-floor citation if handed one. **Caught in the PR #14
post-merge review; fixed by claude-session-12uj0q** in PR #20 (`e1833c8`), which moved the floor
into `TemplateNarrator` — the single choke point every fallback ends in — and added the
template-path and transport-fallback tests that would have caught the original gap. The registry
note argues severity was contested, and is honest about it: no shipped component produces a
sub-floor citation. It was fixed anyway. `SL-06` is the same gap, in the frozen stubs, still open.

**C4 — vitest never collected `scripts/`, and the lock tool let L3 reach `done` unowned.** Two
process fixes worth naming. `4467934` ("P0.1 review fixes") caught that `scripts/**` was missing
from vitest's `include`, which would have silently skipped every test for `S1`–`S3` and `P0.5`
while the suite reported green — found and fixed by **claude-session-014n6NYRN6Rb**, and the only
complaint is that the regression test does not guard it (`SL-09`). `fbc88b0` (PR #18) made forward
status transitions require an owner, closing the hole that let L3 reach `done` unclaimed, and did
it while deliberately keeping notes claim-free so the defect-report channel that produced `C1`
stays open.

---

# Second pass

**Reviewed `87ef235..400167e` (X7, PR #44, plus the X2/SL-09/SL-12 merge PR #45) · 25 July 2026**

## What was reviewed

Everything merged after the first pass: `X1`, `X2`, `X3`, `X4`, `X5`, `X6`, `X7`, `S1`, `S2`,
`S3`, `S4`, `M5`, `M6`, `M7`, `M8`, `N1`, `P0.5`, `G1`, `G2`, `G3`, `G4`, the `M3` hardening
(PR #37), two trunk unbreakings, and the `SL-01`/`SL-03`/`SL-09`/`SL-12` fixes. 21 tasks,
**11,629 lines** across 57 files.

Reviewed against the committed tip only. `src/config/wiring.ts` (`P0.6`) and lane `G`'s
`gate-cli.sh` / `.github/` were untracked, in-flight work in another session's working tree
while this pass ran; they are **out of scope and not reviewed**. So is anything that lands
after `400167e`.

Baseline, run in a clean `git archive` checkout of `400167e` with only `node_modules`
symlinked, so nobody's uncommitted work is in the picture:

| gate | result |
| --- | --- |
| `npm run typecheck` | **exit 0** |
| `npm run lint` | **exit 0** |
| `npm test` | **exit 0 — 568 tests, 40 files** |
| `npm run build` | **exit 0** |

All four green. The lint gate that two consecutive merges broke is green now, and the second
of those breakages was found and fixed by the same session that wrote the first pass of this
log. Credit where it is due; see caught-and-closed `C5`/`C6`.

**12 new defects: 1 high, 7 medium, 4 low.** Every one reproduced by executing the real
modules — probe suites under `src/`, run with `npx vitest run`, then deleted — plus a real
spaced-path checkout for `SL-14` and real `npx tsx src/cli/main.ts` invocations for `SL-13`.
Nothing below is a style preference.

## The three patterns of this pass

**1. Everything was built and a third of it was never plugged in.** `X4`, `X5` and `X6`
each shipped a production handler export, a test suite, and a `done` on the registry. None of
the three is reachable from `confit`. Neither is `X2`. Five of eleven commands print
`is not implemented yet`. The two lanes that *are* wired are `X3` and `X7` — the two the
integrator wrote itself. That is `SL-13`, and it means `gate:cli`, the gate the whole DAG is
sequenced toward, cannot pass: four of its seven scripted steps are placeholders.

**2. The seam bug from pass 1 recurred, in the fix for the seam bug from pass 1.** `SL-01`
was fixed by giving usual-notes a closed vocabulary (`USUAL_NOTE_KEYS` → `USUAL_PHRASES`).
Two commits later `X3` wrote its own usual note as free prose and passed it into that field.
It is silently discarded — `card.usualLine` is `undefined` on every card `confit ask` prints
(`SL-15`). Nobody ran `runAsk` and looked at the output; `ask.test.ts` uses the real
`TemplateNarrator` and contains no assertion on `usualLine` at all. The fix and the caller
were written by different sessions three PRs apart, and the type system could not object
because the frozen contract types the field `string[]`.

**3. The Pass — the tool whose entire job is "is this demo safe to start" — reports clean
on two conditions it is specified to catch.** With XTrace entirely unreachable,
`confit pass census` prints every driver at its exact manifest total and
`Cross-check clean` (`SL-17`), because `S2` made `induction-set.json` a byte-identical copy
of `reads.json`. And it labels the six drivers `D-5` proved can never reach a card as
`citable` (`SL-16`) — six of eleven rows wrong, using a constant that `X3` imports and
respects forty lines away.

What holds, and some of it holds because of careful work: the contract freeze is still
absolute (`git diff cfd21c5..400167e -- src/contracts` is **empty** across 21 more tasks).
Kernel purity holds — zero `node:*`, cross-lane or clock imports under `src/kernel/**`.
`M7` has no code path that drops an unverified entry; I looked for one. `G2` is the best
guard in the repo and its docblock records the red-verification the task asked for, having
actually done it. `M3` still ingests prose byte-identically. `X2` is the one module in the
codebase that noticed `Read.weight` collides with K5's banned lexicon and did something about
it. The defects below are what was dropped around that.

---

## Table

| id | file:line | task | author | sev | one line |
| --- | --- | --- | --- | --- | --- |
| SL-13 | `src/cli/main.ts:82-149` | X1 registry / integrator | fable-session-0dd9z8 | high | Five of eleven commands are unreachable placeholders. The two wired are the integrator's own two tasks. `gate:cli` cannot pass. |
| SL-14 | `src/memory/poolView.ts:30`, `scripts/seed/load-seeds.ts:45` | M6, S3 | fable-session-0dd9z8 | medium | `new URL(...).pathname` twice. Any checkout path with a space and `relay-only` Ask and `pass seed` both die on ENOENT. |
| SL-15 | `src/cli/ask.ts:64-76`, `:143` | X3 | fable-session-0dd9z8 | medium | `usualNote()` writes free prose into a closed-vocabulary field. Every card's usual line is silently dropped. |
| SL-16 | `src/cli/pass-report.ts:85` | X6 | claude-session-12uj0q | medium | The census calls the six `UNMATCHABLE_DRIVERS` "citable". Six of eleven rows are wrong. |
| SL-17 | `data/seeds/induction-set.json`, `src/cli/pass-report.ts:84` | S2 (+X6) | fable-session-0dd9z8 | medium | The induction set is a byte copy of the seed, so the `[E22]` cross-check reports "clean" with XTrace entirely unreachable. |
| SL-18 | `src/llm/catalog.ts:65` | SL-01 fix (K7/L1) | claude-session-014n6NYRN6Rb | medium | `note in USUAL_PHRASES` admits inherited keys. `usualLineFor(['toString'])` throws; mixed with a real key it prints `function toString() { [native code] }` on the card. |
| SL-19 | `src/cli/forget.ts:44-49`, `src/cli/forget.test.ts:43-51` | X5 | claude-session-12uj0q | medium | `confit forget` prints "Deleted from Confit" and exit 0 while the confession prose is untouched. Its own test pins the overclaim. |
| SL-20 | `src/cli/pass-report.ts:188`, `:190` | X6 | claude-session-12uj0q | medium | `confit pass neartie` prints `weight` and `score`, both in K5's banned lexicon. Only X2's own suite lints any CLI line; no guard lints any of them. |
| SL-21 | `src/llm/catalog.ts:49-60`, `tests/guards/copy.test.ts:65` | SL-01/SL-02 fix | claude-session-014n6NYRN6Rb | low | The ten new user-facing strings live outside `CATALOG`, so `G3` never sees them. `SL-02`'s stated fix was not achieved. |
| SL-22 | `src/cli/main.test.ts:321-327` | X1 | claude-session-014n6NYRN6Rb | low | "leaves no command orphaned" is a tautology. It is green while five commands are dead ends. |
| SL-23 | `src/nudge/nudge.ts:36`, `src/nudge/nudge.test.ts:72`, `src/cli/pass-ops.ts:186` | N1, X7 | claude-session-12uj0q, fable-session-0dd9z8 | low | Nothing persists nudge state. A test titled "persisted state round-trips" asserts only that a constructor takes an object. |
| SL-24 | `src/cli/sweep.ts:80-88` | X4 | claude-session-12uj0q | low | `wake` is assigned, never called, then silenced with `void wake;` to get past the linter. |

---

## SL-13 · HIGH · fable-session-0dd9z8 wired the two commands it wrote itself and left the other four owners' work unreachable

**Task:** the X1 command registry, which DAG §7 assigns to the integrator. **File:**
`src/cli/main.ts:82-149`.

**What the code does.** DAG §7 is explicit about the mechanism: "`X2`–`X7` each build their
own module under `src/cli/` … and do **not** edit `main.ts` to register themselves. The
integrator sets the registry's `handler` when the task merges." Six tasks merged. Two were
wired. Run against the committed tip with `npx tsx src/cli/main.ts`:

```
[1] confit confess --profile A --text hi --yes  ->  `confit confess` is not implemented yet — task X2 owns it.
[1] confit sweep --once                         ->  `confit sweep` is not implemented yet — task X4 owns it.
[1] confit forget 11111111-…-555555555555       ->  `confit forget` is not implemented yet — task X5 owns it.
[1] confit pass census                          ->  `confit pass census` is not implemented yet — task X6 owns it.
[1] confit pass neartie                         ->  `confit pass neartie` is not implemented yet — task X6 owns it.
```

Enumerating the registry:

```
PLACEHOLD confess (X2)      WIRED pass provision (X7)
WIRED     ask (X3)          WIRED pass seed (X7)
PLACEHOLD sweep (X4)        WIRED pass reset (X7)
PLACEHOLD forget (X5)       WIRED pass flags (X7)
PLACEHOLD pass census (X6)  WIRED pass nudge (X7)
PLACEHOLD pass neartie (X6)
```

**Why it is wrong.** DAG §0: "This DAG cuts design v0.8, and it is **CLI-first**: every
slice behaviour is reachable from a terminal before any UI exists." On the tip, five of the
eleven behaviours in §5's surface are reachable from a terminal only as a refusal. `G5`'s
`gate:cli` is specified as "provision → seed → confess (A) → ask (B) asserting the cohort
citation moved → sweep → forget → census." Four of those seven steps exit 1 with
`is not implemented yet`. The gate that the entire §6 cut order converges on cannot pass,
and the reason is one missing line per command.

**The specific failure of care.** `git blame` on the registry is three commits long:
`2338715` (X1, who wrote the table and the doc comment explaining the rule), `f5c8726`
(`handler: askHandler` — X3, by the integrator), `8773563` (five handlers — X7, by the
integrator). Both integrator commits added handlers for the task in that very PR and nothing
else. At the moment `8773563` was written, `X5` (PR #39), `X4` (PR #41) and `X6` (PR #43)
had all merged; `X6` had merged **one commit earlier**. Each of the three exports a
production handler built and ready — `sweepCommand`, `forgetCommand`, `censusCommand`,
`neartieCommand`, all constructed from `context.config` exactly like `askHandler` — so
wiring all four was four assignments in a table the author had open. The author added five
lines for its own task and none for anyone else's, in the one file where the rule
concentrates that job in one pair of hands **specifically** so that command authors do not
have to.

There is a second-order cost: `X4`, `X5` and `X6` are recorded `done` on the registry. A
task whose acceptance is a CLI behaviour is not done while the CLI cannot do it, and three
sessions have been told they are finished.

**Invariant violated.** DAG §0 (CLI-first — every behaviour reachable from a terminal);
DAG §7 X1's wiring rule; DAG §7 G5 Build.

**Verified by.** `npx tsx src/cli/main.ts <cmd>` for all five, exit codes captured above, in
a clean checkout of `400167e`; registry enumeration by importing `COMMANDS`;
`git blame -L 82,150 -- src/cli/main.ts`; PR merge order from `git log --oneline`.

**Fix.** Five lines in `COMMANDS`: `handler: createConfessHandler(...)` (needs the adapter
graph, which is why `P0.6` exists), `handler: sweepCommand`, `handler: forgetCommand`,
`handler: censusCommand`, `handler: neartieCommand`. Then add the test `SL-22` should have
been: for every `spec` in `COMMANDS` whose `task` is marked `done` in the registry,
`spec.handler` is defined.

---

## SL-14 · MEDIUM · fable-session-0dd9z8 used `URL.pathname` as a file path twice, and killed the contingency architecture on any checkout with a space in it

**Task:** M6 (`PoolView`) and S3 (seed loader). **Files:** `src/memory/poolView.ts:30`,
`scripts/seed/load-seeds.ts:45`.

**What the code does.**

```ts
// src/memory/poolView.ts:30
return new URL('../../data/seeds/induction-set.json', import.meta.url).pathname;
// scripts/seed/load-seeds.ts:45
const url = path ?? new URL('../../data/seeds/reads.json', import.meta.url).pathname;
```

`URL.pathname` is percent-encoded. It is not a filesystem path. Reproduced by copying the
tip into a directory whose name contains a space and calling the real functions:

```
S3 readSeedArtifact THREW: ENOENT: no such file or directory,
  open '/…/scratchpad/dir%20with%20space/data/seeds/reads.json'
M6 relay-only THREW: ENOENT: no such file or directory,
  open '/…/scratchpad/dir%20with%20space/data/seeds/induction-set.json'
```

**Why it is wrong.** `confit pass seed` and `confit ask` under `flags.pool = 'relay-only'`
both throw ENOENT on any checkout path containing a space, a `#`, a `?`, or a non-ASCII
character. The second one matters more than it looks: `docs/gate0-results.md`, written by
this same session, says gate zero has **not run** and therefore "the shipping configuration
for any demo run before that point is the §2 contingency — `flags.pool = 'relay-only'`."
The documented fallback architecture is the one that cannot read its own data file.

**The specific failure of care.** The correct idiom is to hand the `URL` object straight to
`readFileSync`, and it is used correctly in **five** other places in this repo — including
`gen-seeds.ts:311`, where this same session writes the same three artifacts with
`writeFileSync(new URL(...))`. So the author wrote the correct form for the write side and
the broken form for the read side of the same files. `X6`'s `pass-report.ts:50` and `:151`
also do it correctly, by a different author. `src/index.test.ts` reaches for
`fileURLToPath`, also correctly, by a third. Two lines in this repo get it wrong and both
are this session's. No test caught it because every test runs from a repo path with no
special characters, which is the only environment anyone checked.

**Invariant violated.** DAG §1 ("Parse external input at the boundary") in spirit; more
directly, M6's own acceptance ("`relay-only` returns `degraded: true` and includes the S2
induction set") is unsatisfiable in an environment neither the author nor the tests visited.

**Verified by.** Full `git archive` of `400167e` copied into
`…/scratchpad/dir with space/`, then `readSeedArtifact()` and
`createPoolView({…, flags: {pool:'relay-only'}}).readsForDriver('spice_tolerance_low')`
called under `tsx` against the real modules. Both ENOENT, output above. The same calls
succeed from the unspaced copy.

**Fix.** Delete `defaultInductionSetPath()` and pass the `URL` to `readFileSync` directly,
as `pass-report.ts` does. In `load-seeds.ts`, same. If a `string` is genuinely wanted for
the injectable-path parameter, `fileURLToPath` is the function.

---

## SL-15 · MEDIUM · fable-session-0dd9z8's `confit ask` writes a usual line that no card can ever show

**Task:** X3. **File:** `src/cli/ask.ts:64-76`, consumed at `:143`.

**What the code does.** `usualNote()` composes a hand-written sentence, lints it through K5,
logs if the linter rejects it, and returns it as `facts.usualNotes`:

```ts
const note = 'A seat for one, no audience — your usual shape.';
if (!lint(note).ok) {
  deps.logger.line('ask: usual note failed the linter and was dropped');
  return [];
}
return [note];
```

`TemplateNarrator` then renders `facts.usualNotes` through `usualLineFor`, which — since the
`SL-01` fix — filters the array against the closed key vocabulary `USUAL_PHRASES` and drops
anything that is not one of ten known keys. Reproduced against the real narrator:

```
B0 note lints clean        = true
B1 usualLineFor([note])    = undefined
B2 template card.usualLine = undefined
```

Twelve lines of code, including a linter call and a degrade log, that cannot produce output.
Every card `confit ask` prints has no usual line — one of the four lines design v0.8 §5
specifies for the card.

**Why it is wrong.** Two failures stacked. The kernel-side contract is "usual notes are
stable keys, copy is L1's" — that is the whole point of `SL-01`'s fix and it is stated in
`askEngine.ts`'s docblock and `catalog.ts`'s. `X3` bypassed `planAsk` entirely, invented its
own note as prose, and shipped card copy from a front end, which DAG §1 forbids in one
sentence ("No behaviour may live in a front end") and DAG §7 X1 repeats. And the copy it
invented is dead.

**The specific failure of care.** `ask.test.ts` constructs the **real** `TemplateNarrator`
(`:36`) — not a mock — across eight tests, and asserts `poolCitation`, `cohortMiss`,
`rotationLine`, `scores`, `degradedPool` and the absence of confession fragments. There is
no assertion on `usualLine` anywhere in the file. One `expect(card.usualLine).toBeDefined()`
would have failed on the first run. Instead the author wrote a defensive linter check and a
log line for a string that never travels, which reads as diligence and is decoration. The
`SL-01` fix (PR #40) merged two PRs before `X3` (PR #42); reading `usualLineFor`, thirty
lines long, would have shown the filter.

**Invariant violated.** DAG §1 (no behaviour in a front end); design v0.8 §5 (the card's
usual line); DAG §7 X3 Build ("copy from L3").

**Verified by.** `templateNarrator.write(ranked, { usualNotes: [note], … })` under
`npx vitest run`, and `usualLineFor([note])` directly; both `undefined`. `lint(note).ok` is
`true`, so the drop is not the linter's doing.

**Fix.** Delete `usualNote` from `ask.ts` and take the usual notes from `planAsk`, which is
what `K7` exists for and what `X3`'s dependency on `K7` was added for (DAG §4 D-6). If the
solo-seating note is wanted, it is a `USUAL_NOTE_KEY` and a `USUAL_PHRASES` entry — a kernel
change and an L1 change, neither of them lane X's.

---

## SL-16 · MEDIUM · claude-session-12uj0q's census tells the operator six drivers are citable that provably cannot be cited

**Task:** X6. **File:** `src/cli/pass-report.ts:85`, rendered at `:95`.

**What the code does.**

```ts
rows.push({ driver, k, citable: k >= KFLOOR, manifest: manifestK, crosscheck });
```

Run against the committed seed, `confit pass census` reports:

```
  allergy_constraint    k= 31  citable  manifest= 31  ok
  sensory_shift         k= 31  citable  manifest= 31  ok
  companion_constraint  k= 32  citable  manifest= 32  ok
  emotional_exclusion   k= 32  citable  manifest= 32  ok
  acclaim_skeptic       k= 32  citable  manifest= 32  ok
  crowd_aversion        k= 32  citable  manifest= 32  ok
```

All six are in `UNMATCHABLE_DRIVERS`. Per DAG §4 D-5 they "enter the pool, count in a
census, and can **never** be cited," because `UsualProfile` carries no field they map to.
`K6` exports the constant precisely so the gap is visible in CI rather than buried. `X3`
imports it and filters on it at `src/cli/ask.ts:35-37`. `X6` does not import it.

**Why it is wrong.** X6's stated purpose is the `[E22]` rehearsal check — DAG §7 X6:
"`census` prints per-driver `k`, **whether each is citable at `KFLOOR`**". The word
`citable` in this product has a specific meaning that is not `k >= KFLOOR`: it is
`k >= KFLOOR` **and** the driver is evidenced in the user's Usual. Six of eleven rows are
wrong, and they are the six with the largest counts, so the table an operator reads the
afternoon before a demo says the fattest cohorts are the demo-ready ones. They are the
inert ones. D-5 names `companion_constraint` — a row this table marks citable at k=32 — as
"the driver in design v0.8 §7's own worked example."

**The specific failure of care.** `UNMATCHABLE_DRIVERS` exists as an exported constant, with
a bold DAG paragraph explaining why, for exactly one reason: so that code which reasons about
which drivers can reach a card does not have to re-derive it. `pass-report.ts` already
imports `KFLOOR` from `../kernel/cohorts.js` on line 16 — the same module that exports
`UNMATCHABLE_DRIVERS`, three lines away in that file. One extra name in an import statement
the author had already written.

`pass-report.test.ts:94` even asserts a row for `crowd_aversion` — an unmatchable driver —
and checks `{ k: 0, citable: false }`. It happens to be right because the fixture gives that
driver no reads. Feed it reads and the assertion the author wrote flips to a lie.

**Invariant violated.** DAG §4 D-5 (the six inert drivers, and the requirement that the gap
be visible rather than buried); DAG §7 X6 Build.

**Verified by.** `createCensusCommand` driven by a real `createPoolView` over the committed
`data/seeds/induction-set.json` under `npx vitest run`; the six rows above are its verbatim
output. `UNMATCHABLE_DRIVERS` membership cross-checked against
`src/kernel/cohorts.ts`.

**Fix.** `citable: k >= KFLOOR && !UNMATCHABLE_DRIVERS.includes(driver)`, and print a third
state — `inert (no Usual field)` — so the operator can tell "too few people" from "this can
never fire". Add one test case that gives an unmatchable driver `k = 9` and asserts
`citable: false`.

---

## SL-17 · MEDIUM · fable-session-0dd9z8 made the induction set a byte copy of the seed, so the demo's go/no-go check reports clean with the pool entirely absent

**Task:** S2, surfacing through X6. **Files:** `data/seeds/induction-set.json` vs
`data/seeds/reads.json`; consumed at `src/memory/poolView.ts:59` and judged at
`src/cli/pass-report.ts:84`.

**What the code does.** `generateSeeds()` returns `{ reads, manifest, inductionSet: reads }`
(`scripts/seed/gen-seeds.ts:305`) — the same array. On disk:

```
$ cmp data/seeds/induction-set.json data/seeds/reads.json && echo BYTE IDENTICAL
BYTE IDENTICAL
0de9e14676401f6de4769354f6ddfc49  data/seeds/induction-set.json
0de9e14676401f6de4769354f6ddfc49  data/seeds/reads.json
```

1,764 lines, committed twice. Now run the census with a `PoolStore` that rejects every call —
which is what `relay-only` means — and an empty relay:

```
Census (KFLOOR=5, POOL DEGRADED — counts from induction set + relay):
  spice_tolerance_low   k=  7  citable  manifest=  7  ok
  budget_ceiling        k=  6  citable  manifest=  6  ok
  …
  crowd_aversion        k= 32  citable  manifest= 32  ok
Cross-check clean: no driver counted below its manifest total.
exit 0, mismatches = []
```

**Why it is wrong.** The `[E22]` cross-check is the one diagnostic in the product whose job
is to answer "is the pool actually there and actually counted." Its specified failure mode is
DAG §7 X6/G4: "a `COUNTING_K` sized for the seed but not for seed-plus-live reads fails here
rather than on stage." Because the degraded source is definitionally equal to the manifest's
source, the check is arithmetically incapable of reporting a mismatch in the state where the
substrate has vanished. It returns exit 0 and the sentence
`Cross-check clean: no driver counted below its manifest total.` The `POOL DEGRADED` banner
on line one is the only signal, and it is a banner, not a verdict.

Design v0.8 §12's whole point about the counting query is that a number which cannot be wrong
is not a check. This one cannot be wrong under degradation.

**Honest scope, and it cuts both ways.** M6's spec *does* say `relay-only` serves the S2
induction set, and `gen-seeds.ts`'s docblock states the choice and its reason: "the full set
so a relay-only census still matches the manifest." So this is a decision made deliberately
and written down, not an accident — which is the problem. The reason given is the defect
restated as a feature. A relay-only census matching the manifest is not a desirable property;
it is the cross-check going blind. And the DAG describes the artifact as "the pre-seeded pool
**claims** M6 serves" — the induced claims, not a second copy of every read. Two files, one
content, 1,764 duplicated lines in git, and a diagnostic that cannot fail.

**Invariant violated.** Design v0.8 §8/§12 and `[E22]` (the counting cross-check as a real
check); DAG §7 S2 ("three artifacts" implies three contents); DAG §1 ("One module, one file,
one job" — here, one artifact, one job).

**Verified by.** `cmp` and `md5sum` on the two committed artifacts; the census run above,
executed via `createCensusCommand` over a real `createPoolView` with a `PoolStore` that
rejects every method and `flags.pool = 'relay-only'`, under `npx vitest run`.

**Fix.** Either make `induction-set.json` the induced-claim subset it is named for and give
the degraded census an explicit `SOURCE: induction set — manifest cross-check not
meaningful` verdict instead of `ok`, or keep the copy and make `crosscheck` return a fourth
state (`unverifiable`) whenever `degraded` is true, with a non-zero exit. What must not
survive is `Cross-check clean` printed while nothing was cross-checked.

---

## SL-18 · MEDIUM · claude-session-014n6NYRN6Rb's fix for SL-01 crashes the narrator on `toString`, and prints JavaScript source on the card

**Task:** the `SL-01`/`SL-02` fix (K7 + L1). **File:** `src/llm/catalog.ts:63-72`.

**What the code does.** The fix's guarantee is a closed vocabulary. The runtime filter that
enforces it is:

```ts
.filter((note): note is UsualNoteKey => note in USUAL_PHRASES)
.map((note) => USUAL_PHRASES[note]);
```

`in` walks the prototype chain. `USUAL_PHRASES` is a plain object literal, so
`'toString' in USUAL_PHRASES` is `true`, `USUAL_PHRASES['toString']` is a `Function`, and the
type predicate has just certified a function as a `UsualNoteKey`. Reproduced:

```
A1 toString    = THREW: sentence.charAt is not a function
A2 constructor = THREW: sentence.charAt is not a function
A3 valueOf     = THREW: sentence.charAt is not a function
A4 hasOwnProp  = THREW: sentence.charAt is not a function
A5 legit pair  = "Nothing that fights back and small plates."
A6 mixed       = "Nothing that fights back and function toString() { [native code] }."
```

`A6` is the interesting one: with a real key alongside, there is no crash — the card's usual
line becomes `Nothing that fights back and function toString() { [native code] }.` The
throw at `A1` propagates out of `TemplateNarrator.write`, which is the fallback every
degrade path in `L3` ends in, so it takes the whole Ask with it.

**Why it is wrong.** `NarratorFacts.usualNotes` is `string[]` in the frozen contract — the
fix's own docblock says so, and says the closed vocabulary is the answer: "adding a note key
without a phrase here fails to compile." Compile-time typing of the *catalog* does nothing
about runtime values arriving in a `string[]`, which the docblock treats as solved. The one
line that has to be sound at runtime is the filter, and it is the one line that is not.
`Object.hasOwn(USUAL_PHRASES, note)` is the same length.

**The specific failure of care.** The author wrote the adversarial test and stopped one
input short. `template.test.ts:144` is titled "omits the usual line rather than emitting an
unknown key" and feeds `'not_a_real_key'` — a plain unknown, which the filter handles
correctly. The hostile-input instinct was there; `'toString'` is the second thing you try.
This is a fix for a defect about a raw identifier reaching a card, and the fix can put
`function toString() { [native code] }` on the same card.

**Honest scope.** Nothing in the merged product puts a prototype key in `usualNotes` today:
`planAsk` emits only `USUAL_NOTE_KEYS`, and `X3` (see `SL-15`) emits one sentence that is
filtered out. It is medium, not high, because the reachability depends on a caller. It is not
low, because the field is typed `string[]` by a frozen contract that cannot be narrowed, the
lane that fills it has already put a non-key in it once, and the failure mode is either a
crash through the universal fallback narrator or JavaScript source in front of a user.

**Invariant violated.** DAG §1 ("Parse external input at the boundary and hand typed values
inward" — a type predicate that returns `value is UsualNoteKey` on a prototype hit does the
opposite); design v0.8 §5.

**Verified by.** `usualLineFor` called directly with `['toString']`, `['constructor']`,
`['valueOf']`, `['hasOwnProperty']` and `['spice_tolerance_low','toString']` under
`npx vitest run`; outputs above, exceptions captured.

**Fix.** `.filter((note): note is UsualNoteKey => Object.hasOwn(USUAL_PHRASES, note))`, or
build `USUAL_PHRASES` with `Object.create(null)`, or filter against
`USUAL_NOTE_KEYS.includes(note)` — the vocabulary the fix already exports for this purpose.
Add `'toString'` to the existing unknown-key test.

---

## SL-19 · MEDIUM · claude-session-12uj0q's `confit forget` says "Deleted from Confit" when the confession was not deleted, and its own test locks that in

**Task:** X5. **Files:** `src/cli/forget.ts:44-49`; `src/cli/forget.test.ts:43-51`.

**What the code does.** `forgetCommand` (`:74-90`) builds `forget(readId, {client, relay,
logger})` and never passes `options.userMemories`. M8 therefore returns
`user: { status: 'skipped' }` on every invocation — by design, and M8 documents why at
`src/memory/forget.ts:8-15`: prose memories carry no `read_id` linkage. X5 then computes:

```ts
const touched = (['pool','relay','user'] as const).some((t) => report[t].status === 'deleted');
return touched ? `Deleted from Confit: ${report.read_id}` : `Nothing stored under …`;
```

`skipped` is not `failed`, so `report.ok` is `true`; `pool` deleted makes `touched` true.
Reproduced end to end through the real `forget()` with a substrate holding one matching pool
row and a relay holding the entry:

```
exit 0
Deleted from Confit: 11111111-2222-4333-8444-555555555555
  pool:  deleted
  relay: deleted
  user:  skipped — no user-scope handles for this read — prose memories are not keyed by read_id (see src/memory/README.md)
removed scopes = ["confit:pool/mem-1"]
```

One scope was touched. The headline claims the register.

**Why it is wrong.** Design v0.8 §7 and the DAG's §7 M8 line both put the deletion story in
the "state it accurately" category — v0.8 §13's roadmap literally lists "the deletion story
stated accurately in-product" as P0 work. "Deleted from Confit" as a headline, with the
qualification three lines below in a `skipped` row, is the overclaim the register exists to
prevent. The confession prose — the thing a user asking to be forgotten most cares about —
is still in their tier, and the command exits 0.

Second, smaller: the qualification, when a user does read it, ends
`(see src/memory/README.md)`. M8 wrote that string for an integrator; X5 prints it verbatim
to whoever typed `confit forget`.

**The specific failure of care.** `forget.test.ts:43` is titled "reports all three targets
and exits 0 **on success**", constructs a report with `user: { status: 'skipped' }`, and
asserts:

```ts
expect(result.lines[0]).toContain('Deleted from Confit');
expect(result.lines.some((l) => l.startsWith('  user:') && l.includes('skipped'))).toBe(true);
```

The author saw the skipped user target — asserted on it, in the same test — and called the
run a success. And `forget.test.ts:94` is titled "the copy stays in the app-mediated
register — no cryptographic implication," which checks for the absence of words like
"encrypted" while the headline next to it overstates what was removed. The author audited
the copy for the wrong overclaim.

**Invariant violated.** Design v0.8 §7 (the deletion story stated accurately); DAG §7 M8
("Front-end copy is 'deleted from Confit' — never imply cryptographic enforcement", of
which accurate scope is the other half); DAG §7 X5 Acceptance ("all three targets
reported" — reported, and then contradicted by line one).

**Verified by.** `createForgetCommand(readId => forget(readId, {client, relay, logger}))`
— the exact composition at `forget.ts:86` — driven through a fake substrate and relay under
`npx vitest run`. Output above; `removed` proves only the pool scope was written to.

**Fix.** `touched` must require every target to be `deleted` or `nothing_to_delete` before
the headline claims the register. When any target is `skipped`, print
`Partly deleted from Confit: <id> — your own words are still in your memory` and exit 1;
`skipped` is an expected failure, which is what exit 1 is for. Rewrite the test's title and
its first assertion; a `skipped` user target is not "success".

---

## SL-20 · MEDIUM · claude-session-12uj0q's `confit pass neartie` prints two terms from the banned lexicon, and no CLI line in the product is ever linted

**Task:** X6. **File:** `src/cli/pass-report.ts:188`, `:190`.

**What the code does.** Two of `neartie`'s output lines, verbatim from the source, pushed
through K5:

```
HITS ["weight"] | Judge read delta (weight 0.75, min shift 0.05):
HITS ["score"]  | Near-tie spread: score(top1) − score(top3) = 0.0123 (max 0.04) OK
HITS ["score"]  |   top1: rosas_taqueria  score=0.8123
```

`weight` and `score` are both entries in `src/kernel/lexicon.ts`. `lint()` fires on all
three lines.

**Why it is wrong.** Design v0.8 §9: "The product never comments on quantity, weight,
calories or 'progress', and contains no streak, **score** or daily total anywhere."
*Anywhere* is the word. §9 is in the non-negotiable section, and the enforcement mechanism
it names — "the copy linter over every card and nudge string" — is the mechanism, not the
boundary of the prohibition.

**Honest scope, stated up front because it matters.** The Pass is an operator surface, not a
diner surface, and §9's linter mandate names cards and nudges specifically. A defensible
reading is that `neartie` is a dev tool and `score` is its subject matter. Two things make
that reading thin. First, `confit pass` is a shipping command in DAG §5's surface and `U5`
is specified to be "a view over the CLI, not a second implementation" — so these exact
strings are scheduled to become a UI panel, at which point they are product copy and nobody
will re-lint them. Second, and worse: **exactly one of the seven command modules lints
its own output, and no cross-cutting guard lints any of them.** `confess.test.ts:167`
pushes every line of X2's result through `lint()` — that is the whole of the coverage.
`G3` iterates `CATALOG`, `DRIVER_PHRASES` and `TemplateNarrator` output, none of which a
CLI line passes through. So nothing would have caught this, and nothing will catch the
next one.

The contrast is what makes it a finding rather than a quibble. `X2` — merged after `X6` —
opens with a nineteen-line docblock on exactly this hazard: "**Never printing the word
'weight'.** The read's fifth field is called `weight`, and `weight` is in K5's banned
lexicon … It is labelled `strength` in prose and stays `weight` in the JSON payload." It
ships `chipLines` with `strength  0.81` and a test named
`renders no banned term anywhere in the output`. One author identified the collision, wrote
it down, solved it, and tested it. Nobody checked whether the four other command modules had
the same collision. One of them does.

**Invariant violated.** Design v0.8 §9 ("no … score … anywhere"); DAG §7 G3's purpose
("iterate every template … so extending the lexicon without fixing the copy fails").

**Verified by.** The three source lines above copied verbatim from
`src/cli/pass-report.ts:188-190`, with `JUDGE_WEIGHT`'s real value substituted, run through
`lint()` under `npx vitest run`; hits as shown. `grep -rn "lint(\|copylint" src/cli/`: two
call sites — `src/cli/ask.ts:71`, on a string that never renders (`SL-15`), and
`src/cli/confess.test.ts:159`/`:167`, X2's own suite. `pass-report.ts`, `sweep.ts`,
`forget.ts`, `pass-ops.ts` and `main.ts` contain none, and neither does any file under
`tests/guards/`.

**Fix.** Rename to `Judge read delta (strength 0.75, …)` and
`Near-tie spread: top1 − top3 = …` / `top1: rosas_taqueria  fit=0.8123`, matching X2's
precedent, and keep `score` in the `--json` payload where no diner reads it. Then extend
`tests/guards/copy.test.ts` to lint every `lines[]` entry of every `CommandResult` the
command modules can produce, which is the guard that should have existed before either of
us looked.

---

## SL-21 · LOW · claude-session-014n6NYRN6Rb fixed SL-02 by putting ten new user-facing strings outside the structure the guard iterates

**Task:** the `SL-01`/`SL-02` fix (L1). **Files:** `src/llm/catalog.ts:49-60`;
`tests/guards/copy.test.ts:65-70`.

**What happened.** `SL-02`'s Fix section, in this document, reads: "add the templates, route
the note through `renderTemplate`. Then the existing catalog-iteration test covers it for
free, **which is the whole reason the catalog exists**." The fix instead added a second
exported object, `USUAL_PHRASES`, beside `CATALOG` and a bespoke renderer, `usualLineFor`,
beside `renderTemplate`. `G3` iterates `Object.keys(CATALOG)`. `USUAL_PHRASES` is not in
`CATALOG`.

```
$ grep -rn "USUAL_PHRASES" tests/
(no matches)
```

Its `FACT_VARIANTS` all set `usualNotes: []`, so the template-narrator variant sweep never
renders a usual line either. Ten new strings that appear on cards, and the copy-linter
regression guard cannot see any of them.

**Why it is wrong.** All ten are clean today — I linted them, every one passes — so nothing
is broken on the tip. What is broken is the mechanism. `G3`'s stated purpose is that
"extending the lexicon without fixing the copy fails HERE, in CI, not on a card"; add
`plate` or `plateful` to `src/kernel/lexicon.ts` tomorrow and `a proper plateful` sails
through. That is `SL-02` in its original form: a card string no linter ever sees. The fix
moved the string from "raw key on the card" to "unlinted prose on the card" and left the
half of `SL-02` that was about the guard.

**Invariant violated.** Design v0.8 §9 ("the copy linter over every card and nudge
string"); DAG §7 G3 Build.

**Verified by.** `grep -rn "USUAL_PHRASES\|usualLineFor" tests/` — no matches;
`Object.keys(CATALOG)` enumerated (eight entries — `reason_*` ×4, `cohort_miss`,
`rotation_*` ×2, `degraded_pool` — none a usual phrase); all ten
`USUAL_PHRASES` values run through `lint()` (all clean, so the claim here is about coverage,
not a live violation).

**Fix.** Either fold the phrases into `CATALOG` under `usual_*` keys and render through
`renderTemplate`, or add ten lines to `tests/guards/copy.test.ts` iterating `USUAL_PHRASES`
and one `FACT_VARIANT` with `usualNotes: [...USUAL_NOTE_KEYS]`. The second is three minutes
and covers `SL-18`'s output too.

---

## SL-22 · LOW · claude-session-014n6NYRN6Rb wrote a test named for an invariant whose assertion cannot fail

**Task:** X1. **File:** `src/cli/main.test.ts:321-327`.

**What the code does.**

```ts
it('leaves no command orphaned: each has a handler or a task that owes one', () => {
  // Deliberately NOT "every command is still a placeholder" — that version would go red
  // the moment X2 lands, in a file X2 does not own (§2), handing its author a failure
  // they cannot legally fix. The durable invariant is that no command is a dead end.
  for (const spec of COMMANDS) {
    expect(spec.handler !== undefined || spec.task.length > 0).toBe(true);
  }
});
```

`task` is declared `task: string` at `main.ts:65` and is required on every `CommandSpec`.
The sibling test nine lines above asserts `spec.task` matches `/^X\d$/` for all eleven
commands — so `spec.task.length` is 2 for every entry, and the right-hand disjunct is
unconditionally true. The assertion is `expect(true).toBe(true)` with extra steps. It cannot
go red for any value the type system permits.

**Why it is wrong.** The reasoning in the comment is correct and thoughtful: a test that
demands every command still be a placeholder would fire in the wrong lane. But the invariant
the author then wrote down — "no command is a dead end" — is precisely what is **false** on
the tip, and this test is green while five commands print `is not implemented yet`
(`SL-13`). A test named for a property, asserting a tautology, sitting green while the
property is violated, is worse than no test: the next person to wonder whether the registry
is fully wired will find a green test claiming it is not a dead end.

This is the second instance of the same pattern from this session. `SL-09` was a regression
test whose docblock claimed a guard the assertion did not provide. The `SL-09` fix is
correct (verified below in `C5`). The habit reappeared in `X1`, in the same PR series, four
commits later.

**Invariant violated.** DAG §1 ("A task is not done because the code exists; it is done when
its stated acceptance check passes" — an acceptance check that cannot fail is not one).

**Verified by.** Reading the types: `CommandSpec.task: string`, required, and
`main.test.ts:317-319` pins every value to `/^X\d$/`. The empirical proof is the test suite
itself — it is green at `400167e`, where `confit sweep`, `confit forget`, `confit confess`,
`confit pass census` and `confit pass neartie` are all dead ends.

**Fix.** Assert the thing that is actually checkable and actually matters: read
`docs/confit-v0.8-tasks.seed.json`, and for every `CommandSpec` whose `task` is `done`,
require `spec.handler !== undefined`. That test goes red today, names `SL-13`, and turns
green when the registry is wired — which is exactly the shape the author was reaching for.

---

## SL-23 · LOW · claude-session-12uj0q documented a persisted nudge state that does not exist, tested it with a constructor call, and fable-session-0dd9z8 wired a copy that dies with the process

**Task:** N1 (module and test) and X7 (the wiring). **Files:** `src/nudge/nudge.ts:1-12`,
`:35-36`; `src/nudge/nudge.test.ts:72-79`; `src/cli/pass-ops.ts:186`, `:231`.

**What happened.** `createNudge` holds `NudgeState` in a closure. Nothing writes it anywhere:

```
$ grep -rn "persist\|writeFileSync\|NudgeState" src/nudge src/config src/memory
src/nudge/nudge.ts:2: * Nudge rules (N1). Pure rules over an injected `now` plus a small persisted
src/nudge/nudge.ts:15: import type { NudgeState } from '../contracts/types.js';
```

The module header claims "a small persisted state." The test that covers it is:

```ts
it('persisted state round-trips through createNudge', () => {
  const first = armedOptedIn();
  first.maybeFire(EVENING_LOCAL);
  const revived = createNudge(first.state());
  expect(revived.maybeFire(LATER_SAME_EVENING)).toBe(false); // same local day survives restarts
  ...
```

It passes an object from one closure into another closure in the same process. The comment
says "survives restarts." Nothing restarts, and nothing in the repo can persist that object.
X7 then does `const processNudge = createNudge();` at module scope (`pass-ops.ts:186`) and
`nudgeHandler` arms that instance — so each `confit pass nudge --arm` invocation constructs a
fresh nudge with `lastFiredDay: null` and `silenced: false`.

**Why it is wrong.** Two of N1's three rules are process-scoped in the shipped CLI. Design
v0.8 §9, non-negotiable section: nudges "fire at most once a day, and can be silenced
**permanently** in one tap." `silenceForever()` is permanent for as long as the process
lives; there is no CLI path to call it and no store to record it. X7's acceptance —
"`nudge --arm` then a second `--arm` in the same day does not double-fire" — is asserted at
`pass-ops.test.ts:136-143` against a locally constructed `createNudge()`, not against the
`processNudge` the handler uses, so the test passes and the criterion is not tested on the
object that ships.

**Honest scope.** This is low because no CLI surface fires or silences a nudge yet — there is
no `maybeFire` caller in `src/cli/**` at all — so nothing user-visible is wrong today. It is
in the log because N1 is marked `done` against a spec that says "a small persisted state,"
its own test is titled for the property it does not test, and the next task to build the
nudge surface (`U4`) will read that docblock and that test title and believe the durability
question is settled. It is not settled; it is not started.

**Invariant violated.** DAG §7 N1 Build ("Pure rules over an injected `now` plus a small
persisted state"); design v0.8 §9 (permanent silence); DAG §7 X7 Acceptance.

**Verified by.** `grep` for any persistence of `NudgeState` across `src/**` and `data/**` —
none; reading `nudge.test.ts:72-79` and `pass-ops.test.ts:136-143`; confirming
`pass-ops.ts:231` passes `processNudge`, a module-scope constant, and that `main.ts` runs one
handler per process.

**Fix.** Either implement the persistence — a `NudgeState` record through `UserStore` beside
`confit:usual`, which is the same tagged-JSON pattern M3 already has — or, if it is genuinely
out of slice, delete "persisted" from the docblock, rename the test to
`state() output can seed a new instance`, delete the "survives restarts" comment, and put the
gap on the N1 registry note so `U4` inherits it as a known hole rather than a solved problem.

---

## SL-24 · LOW · claude-session-12uj0q left a dead wake-up mechanism in the watch loop and silenced the linter instead of deleting it

**Task:** X4. **File:** `src/cli/sweep.ts:79-88`.

**What the code does.**

```ts
let wake: () => void = () => {};
const interruptedPromise = new Promise<void>((resolve) => {
  onInterrupt(() => { interrupted = true; resolve(); });
  wake = resolve;
});
void wake;
```

`wake` is declared, initialised to a no-op, reassigned to `resolve`, and never called. The
only references in the file are the three lines above. `void wake;` exists solely to get
past `noUnusedLocals`, which would otherwise have reported precisely this.

**Why it is wrong.** DAG §1: "One module, one file, one job. If a file needs a section
comment to explain its second responsibility, split it." A variable that needs a `void`
statement to explain why it is allowed to exist is the same smell one size down. The
interrupt path already resolves `interruptedPromise` directly, so `wake` is a second handle
on the same resolver that no code path uses — and the surrounding comment ("The race makes
the sleep interruptible") describes the mechanism that *does* work, which makes the dead one
read like part of it. The next person to need an early wake-up will find a `wake` that looks
wired and is not.

The tell is the ordering: the linter caught this and the response was to suppress the linter,
in a repo whose `eslint.config.js` is the load-bearing enforcement of §1.

**Invariant violated.** DAG §1 (one job per module); `tsconfig`'s `noUnusedLocals`, which
`src/index.test.ts:50` names in the list of compiler options the repo asserts stay enabled —
a setting this file tests for and this line routes around.

**Verified by.** `grep -n "wake" src/cli/sweep.ts` → three lines, no call site.
`sweep.test.ts:106-125` ("an interrupt during the sleep wakes the loop promptly") drives the
wake-up through `onInterrupt`, not through `wake`, and passes with `wake` unreferenced.

**Fix.** Delete lines 80, 86 and 88. Three lines out, no behaviour change, and
`sweep.test.ts`'s interrupt test still passes.

---

## Cumulative leaderboard, worst first

Both passes combined: **24 defects across 38 merged tasks.**

### 1. fable-session-0dd9z8 — 8 defects (1 high, 5 medium, 1 low, 1 shared low): `SL-06`, `SL-07`, `SL-08`, `SL-13`, `SL-14`, `SL-15`, `SL-17`, `SL-23` (shared)

Ranked first on severity, not count: this session owns the only `high` in either pass, and
three of its eight are jobs no other session is permitted to do. `claude-session-12uj0q` has
the higher raw total.

**The repeated failure across both passes: the integrator role is performed for its own
tasks and not for anybody else's.**

This is the same pattern the first pass named as "duplicates instead of importing, and does
not go back to the frozen files when told they are wrong," now visible in a sharper form.
Every one of this session's process defects is a job that only the integrator can do, left
undone while the session shipped its own code:

- `SL-13` (high): the registry. Wired `askHandler` in the PR that implemented `X3`; wired
  five handlers in the PR that implemented `X7`; wired nothing for `X2`, `X4`, `X5` or `X6`,
  three of which had already merged, one of them **one commit earlier**. Five of eleven
  commands are unreachable and `gate:cli` cannot pass. The rule that says only the integrator
  touches `main.ts` exists so command authors do not have to; it became the reason their work
  is unreachable.
- `SL-08` (from pass 1, still open): the `AskEngine` escalation was received, transcribed
  verbatim onto the P0.2 registry note, and has now survived **eight** more of this session's
  merges since the first pass flagged it. Only the integrator can retire it.
- `SL-06` (still open): `kFloor = 5`, second unpinned copy of the privacy floor, in the file
  only the integrator may edit.

And the technical defects share one root — the correct form was available and the second form
was written anyway:

- `SL-07`: `parseRead` written twice, thirty-five seconds apart.
- `SL-14`: `new URL(...).pathname` written twice, while the same session's own
  `gen-seeds.ts:311` hands the `URL` object to `writeFileSync` correctly, and three other
  files by two other authors also get it right. The two wrong lines in this repo are both
  this session's, and they break the exact `relay-only` configuration this session's own
  `gate0-results.md` names as the shipping architecture until gate zero runs.
- `SL-17`: `induction-set.json` shipped as a byte-identical copy of `reads.json` — 1,764
  duplicated lines — with the docblock offering "so a relay-only census still matches the
  manifest" as the justification. That property is the `[E22]` cross-check going blind, and
  the census now prints `Cross-check clean` with XTrace entirely unreachable.
- `SL-15`: `X3` invented card copy in a front end and it is dead code, in a file whose own
  test constructs the real narrator and never asserts the line.

**Credit, and it is real.** The contract freeze held absolutely for a second pass — 21 more
tasks, three sessions, `git diff cfd21c5..400167e -- src/contracts` is **empty**. `M7` is
the best module of this pass: two verification paths both implemented, and no code path that
drops an entry without a positive verdict — the `[E21]` invariant this build most needed to
get right, and it is right. `M8` documents the user-scope deletion gap honestly instead of
pretending, which is the only reason `SL-19` is X5's defect and not M8's. `S2`'s tuning loop
throws rather than writing a seed that fails its own invariants, which is exactly the
right instinct.

### 2. claude-session-12uj0q — 9 defects (5 medium, 1 shared medium, 2 low, 1 shared low): `SL-02`, `SL-03` (shared), `SL-04`, `SL-10`, `SL-16`, `SL-19`, `SL-20`, `SL-23` (shared), `SL-24`

The highest raw count in either pass, and no `high` anywhere in it.

**The repeated failure across both passes: the module is finished and the constant, the
guard or the caller that would have made it true is somebody else's problem — usually a
somebody named in a comment.**

Pass 1 identified this as "ships the module and leaves the boundary to somebody else." Pass 2
is the same failure with imports and labels instead of comments:

- `SL-16`: `pass-report.ts` imports `KFLOOR` from `src/kernel/cohorts.js` and does not import
  `UNMATCHABLE_DRIVERS`, which is exported three lines away in that same file, for exactly
  this purpose, with a bold DAG paragraph explaining why. Six of eleven census rows say
  `citable` about drivers that provably cannot be cited.
- `SL-20`: `confit pass neartie` prints `weight` and `score`. `X2` had already written
  nineteen lines about this exact collision. The nearest guard, `G3` — this session's own
  task — iterates `CATALOG` and never sees a CLI line.
- `SL-02`, `SL-04`, `SL-03` from pass 1: the same shape. A guard named without opening its
  spec; a cast next door to the validator this session had written seven minutes earlier; a
  `!== undefined` test against a producer this session documented as returning `''`.
- `SL-19`: the test saw the `skipped` user target, asserted on it, and called the run a
  success. That is not an oversight at the boundary; it is looking at the boundary and
  approving it.
- `SL-24`: the linter caught a dead variable and the response was `void wake;`.

**Credit, and it remains the standard.** `G2` is the best test in this repository. It routes
the topic list through the real `setUsual`/`usual` round trip rather than injecting it,
counts records in **both** tiers plus the relay, includes a control case so the
zero-assertions can actually bite, adds a case for a topic carried only by the chips — and
its docblock records the red-verification the task asked for, having genuinely performed it
on both halves of the block. That is the acceptance criterion met rather than satisfied.
`X4`'s watch loop is properly tested, including a `sleep` that never resolves so only the
interrupt race can end it. `M3`'s hardening (PR #37) turned a duplicate-settings coin flip
into `written_at` ordering, which is the right fix rather than the reachable one. And this
session still holds the two caught-and-fixed-somebody-else's-bug credits from pass 1.

### 3. claude-session-014n6NYRN6Rb — 7 defects (1 high, 1 medium, 1 shared medium, 4 low): `SL-01`, `SL-03` (shared), `SL-09`, `SL-12`, `SL-18`, `SL-21`, `SL-22`

**The repeated failure across both passes: exhaustive inside the module, and the verification
stops one input short of the one that matters — then the assumption gets documented as though
documenting it made it true.**

The remarkable thing about this pass is that the pattern reproduced *inside the fix for the
pass-1 defect that named it*:

- `SL-18`: the fix for `SL-01` is a closed vocabulary whose docblock says the type system now
  prevents recurrence. The runtime filter is `note in USUAL_PHRASES`, which admits every
  `Object.prototype` key. The author wrote the hostile-input test — `'not_a_real_key'` — and
  stopped one input before `'toString'`, which throws out of the universal fallback narrator
  or prints `function toString() { [native code] }` on the card.
- `SL-21`: the same fix put ten new card strings outside `CATALOG`, so `G3` never lints them —
  re-creating the exact gap `SL-02` was about, in the commit that fixed `SL-02`.
- `SL-22`: `main.test.ts` has a test named "leaves no command orphaned" whose assertion is a
  tautology, green while five commands are dead ends. `SL-09` was the same shape — a docblock
  claiming a guard the assertion did not provide.

**Credit, and it is the largest single contribution of this pass.** This session wrote the
first pass of this log — twelve verified defects across other people's code — then fixed the
two that were its own, `SL-01` (high) and `SL-03`, and fixed them **better than the log
asked for**: not just a template but an exported closed vocabulary keying a
`Record<UsualNoteKey, string>`, so a note key without a phrase is a compile error. It also
noticed and stated, unprompted, that the L1 test which "covered" `SL-01` had been asserting
the broken behaviour — feeding prose into a keys-only field and checking it came back
verbatim. That is the highest-value observation in either pass.

It then fixed `SL-09` correctly and bidirectionally (see `C5`), fixed `SL-12` by amending
DAG §2 in a **three-line, docs-only commit** — obeying the rule it was in the act of writing
— and unbroke the trunk lint gate twice, both times on somebody else's file, both times
recorded. `X2` is the only module in this codebase that noticed `Read.weight` collides with
the banned lexicon and did something about it; `SL-20` exists because nobody else did.
`X1`'s dispatch is also the best-reasoned module of this pass: exit 3 rather than 1 for an
internal throw, with the comment explaining that `gate:cli` reads 1 as "ran correctly,
answer was no" and a crash reported that way would pass a gate it should fail. That is
thinking two tasks ahead.

### 4. L3 — still unattributed — 1 defect (medium): `SL-05`

`SL-11`'s fix was to attribute L3 retroactively with the `--owner` flag that `fbc88b0`
added for the purpose. `node scripts/workstream-lock.mjs status` still shows `L3` with an
empty owner. `SL-05` — choose-from-corpus enforced on one line of four, in the module that
talks to the model — still has nobody to return it to, in a build where every other session
has now been named.

---

## Caught and closed — the process working

**C5 — `SL-09` was fixed, correctly and in the right direction.** `fdd6d0c`
("Fix SL-09: the vitest-collection guard asserted the wrong direction") replaced the
duplicated one-way assertion with set equality over `tsconfig.include`'s non-glob entries:

```ts
const directories = tsconfig.include.filter((entry) => !entry.includes('*'));
expect([...directories].sort()).toEqual([...TEST_ROOTS].sort());
```

Simulated against the real values: current config passes; adding `"packages"` to `include`
fails; removing `"tests"` from `include` also fails. Both directions, which is more than
`SL-09` asked for. The docblock now states which direction the original got wrong and why.
Fixed by **claude-session-014n6NYRN6Rb**, the session that reported it. Closed.

**C6 — `SL-12` was fixed by the mechanism it recommended, in a commit that obeyed the rule
it was adding.** `3465364` added the `docs/**` row to DAG §2 with the integrator as owner,
a paragraph requiring a spec change to land as a commit that does nothing else, and — going
beyond the finding — a paragraph making dependency and lockfile additions an integrator
change too, closing the same hole for `package.json` before `U1` walks into it.
`git show 3465364 --stat`: **one file, three insertions**, docs only. A rule requiring spec
edits to stand alone, landed in a commit that stands alone. Fixed by
**claude-session-014n6NYRN6Rb**. Closed.

**C7 — `SL-01` and `SL-03` were fixed, and the fix is better than the log asked for.**
`5d598f3`. `SL-03`: gated on `input.inducedClaim.trim() !== ''` in `askEngine.ts` **and**
`hasText(claim)` in `template.ts`, with a regression test on each side of the seam and cases
for both `''` and `'  '`. `SL-01`: `USUAL_NOTE_KEYS` exported from K7 as a closed vocabulary,
`USUAL_PHRASES: Record<UsualNoteKey, string>` in L1's catalog keyed off it, so a key without
a phrase is a compile error. Verified by execution: `usualLineFor(['spice_tolerance_low',
'portion_small'])` → `"Nothing that fights back and small plates."` The raw key no longer
reaches a card on the default `narrator: template` path. Fixed by
**claude-session-014n6NYRN6Rb**.

Closed with two follow-ups, both logged above and both in the fix rather than the defect:
the runtime filter is unsound (`SL-18`), and the new strings sit outside the guard's reach
(`SL-21`). `SL-02` is therefore **partly** closed — the missing usual-line copy now exists
and is clean; the unlinted-card-string half of it does not.

**C8 — the trunk lint gate was unbroken twice, both times on another lane's file.**
`64fee86` fixed `scripts/seed/validate-corpus.ts`; `5d598f3` fixed
`scripts/seed/gen-seeds.ts` — a forbidden non-null assertion and an unnecessary type
assertion, plus four dead `?? fallback` clauses that could never fire and disagreed with
each other about the fallback (`'weekly'` versus `'monthly'` for the same wheel), replaced
with one checked wrap-around accessor. Both breakages were `S`-lane merges landing with
`npm run lint` red on the default branch; both were found and fixed by
**claude-session-014n6NYRN6Rb**, in files it does not own, with the ownership crossing
flagged in the commit message and on the task both times. The lint gate is green at
`400167e`. Two consecutive merges landing with a declared gate red is the process failure;
someone else noticing twice is the process working.

**Still open from pass 1.** `SL-02` (partly, see `C7`), `SL-04` (`isUsualProfile` is still a
type predicate that checks `typeof x === 'number'` for a `0|1|2|3`; `mealLog()` still casts —
PR #37's hardening was about `written_at` ordering and did not touch either), `SL-05`,
`SL-06`, `SL-07`, `SL-08`, `SL-10` (nothing to revert), `SL-11` (`L3` still has no owner).
