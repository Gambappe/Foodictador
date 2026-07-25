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
