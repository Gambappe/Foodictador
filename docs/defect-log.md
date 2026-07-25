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

**Closed** by fable-session-0dd9z8 in #68 (`ec60bc0`): the stubs import `KFLOOR` from
`src/kernel/cohorts.ts` (single source), `StubNarrator` floors its citation, and two pin
tests in `contracts.test.ts` hold both. The same fix landed independently as P0.10 on the
#65 branch — see the coordination note there.

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

**Closed** by fable-session-0dd9z8 in #68 (`ec60bc0`): `AskEngine` deleted from the
contracts, `stubs/askEngine.ts` deleted, the stub's self-agreeing test replaced with the
SL-06 pin tests; `AskInput` remains as the shared input shape, per D-6. The same deletion
landed independently as P0.12 on the #65 branch.

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

**Closed** by fable-session-0dd9z8 as S5. Half the vacuity died with the architecture:
M9/D-7 made counting relay-only and exact, so no census path unions the induction set into
its own cross-check any more. The artifact half is now derived, not copied —
`deriveInductionSet` runs the real `PoolStore.writeReads` against a recording client, so
`induction-set.json` is the exact substrate feed (17 conversations, prose, conv ids) plus
the ask-path probe (`POOL_QUERY` + the seeded place names a faithful claim grounds in) for
G7's live gate. `gen-seeds.test.ts` holds committed == derived in CI, asserts the byte-copy
shape is structurally gone (no `read_id` anywhere), and pins the probe to the query `ask`
actually issues. A feed change now goes red until the artifact is regenerated.

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

---

# Third pass

**Reviewed `400167e..6c78fa2` (U2, PR #54) · 25 July 2026**

## What was reviewed

Every PR merged after the second pass: **#46** (the `SL-04`/`SL-05` fixes), **#47** (`P0.6`
adapter wiring), **#48** (`G6`), **#49** (`G5` — CI and the acceptance gate), **#50** (the
`SL-13`/`SL-18`/`SL-21` fixes), **#51** (`U1` + a self-registered `P0.7`), **#52** (`U3`),
**#53** (`U4`), **#54** (`U2` + a trunk fix). Nine PRs, 9 tasks, **8,776 lines** across 45
files, including the whole of lane U and the first CI workflow this repo has ever had.

Three commits on `claude/upload-code-artifact-zop9uz` after `b76d494` — the gate-zero and
D-7 write-ups — are not in any PR and are **out of scope**. So is `U5`, which is `claimed`
and unmerged, and `M9`/`P0.8`, which are `claimed`/`available`.

Baseline in a clean `git archive` checkout of `6c78fa2` with a fresh `npm ci`:

| gate | result |
| --- | --- |
| `npm run typecheck` | **exit 0** |
| `npm run lint` | **exit 0** |
| `npm test` | **exit 0 — 663 tests, 49 files** |
| `npm run build` | **exit 0** |

All four green **on Node 22**. On Node 20 — the version `package.json` declares, the version
`src/index.test.ts` asserts, and the version `.github/workflows/ci.yml` pins — the suite has
been **red since PR #47** and five consecutive PRs merged on top of it. That is `SL-25`, and
it is why the table above is not the reassurance it looks like.

**12 new defects: 3 high, 4 medium, 5 low.** Every one reproduced by execution against the
real modules — probe suites under `src/` run with `npx vitest run` and then deleted, real
`npx tsx src/cli/main.ts` invocations, real `@testing-library/react` renders under jsdom, and
GitHub Actions job logs read directly for the CI claims. Nothing below is a suspicion and
nothing below is a style preference.

## The three patterns of this pass

**1. The gates arrived, and the gates are the least-verified code in the repo.** `G5` shipped
`scripts/gate-cli.sh` and a file named `tests/guards/acceptance.test.ts` whose docblock quotes
the DAG's seven-step CLI run verbatim. The file imports **nothing from `src/cli/**`**. All
seven steps are re-implemented against the modules underneath the commands, so the acceptance
gate for a build whose §0 is "**CLI-first**" never once invokes the CLI (`SL-26`). In the same
PR series the same session shipped the CI workflow, which went red on its own first run and
stayed red through five merges (`SL-25`). The two things built to catch defects are the two
things nobody checked.

**2. `SL-13` was fixed and then rebuilt, one lane over, by the session that read it.** Lane U
shipped four screens — `AskCard`, `OffLimitsEditor`, `NudgeBanner`, `ConfessScreen`, 1,100
lines, four tasks marked `done`. `grep` finds **zero** references to any of them outside their
own directories. Every route in `src/ui/routes.tsx` still renders `Not built yet — task Ux owns
this screen`, and `src/ui/app.test.tsx:27` **asserts that the placeholder is still there**, so
wiring a real screen in turns the shell's own smoke test red (`SL-27`). The rule invoked to
justify it — "only `U1` touches the shell" — protects two agents from colliding on one file,
and one agent owns `U1`, `U2`, `U3` and `U4`.

**3. Every fix from pass 2 landed, and four of them landed with a residue.** `SL-04` is
genuinely closed and closed well. `SL-05`'s fix rejects the exact probe the log printed and
accepts `"Not the Rosa's Taqueria Downtown Annex tonight."` (`SL-32`). `SL-13`'s fix left two
tests with byte-identical bodies nine lines apart — the `SL-09` shape, third occurrence
(`SL-34`). `SL-21`'s fix linted the phrases in L1's own test file rather than G3's, which is
acceptable, and then `U2` and `U3` shipped eleven new unlinted user-facing strings, one of
which is the word `weight` (`SL-28`).

What holds, and some of it holds because of careful work: the contract freeze is **still
absolute** — `git diff cfd21c5..6c78fa2 -- src/contracts` is empty across 30 more tasks and
four sessions. Kernel purity holds. `SL-04`'s replacement parsers check the actual contract
unions and use the *same* date predicate `K3` uses, so the class of bug is closed rather than
moved. `G6` is a real guard with a real mutation record. `U3`'s `AskCard` renders
`DRIVER_PHRASES[citation.driver]` rather than the enum token, having read `SL-01` and acted on
it — which is precisely why `SL-30` is embarrassing. And `SL-11` is finally closed: `L3` has an
owner.

---

## Table

| id | file:line | task | author | sev | one line |
| --- | --- | --- | --- | --- | --- |
| SL-25 | `src/config/wiring.test.ts:170` (at `9919ff3`), `.github/workflows/ci.yml:18` | P0.6 + G5 | claude-session-014n6NYRN6Rb | high | A Node-22-only API in a repo whose own test pins `engines: ">=20"`. CI red on its first run ever; **five** PRs merged on top of it. |
| SL-26 | `tests/guards/acceptance.test.ts:1-16`, `scripts/gate-cli.sh:60-75` | G5 | claude-session-014n6NYRN6Rb | high | "The CLI acceptance run" imports nothing from `src/cli/**`. Seven named steps, seven re-implementations, zero commands invoked. |
| SL-27 | `src/ui/routes.tsx:41-84`, `src/ui/app.test.tsx:27` | U1–U4 | claude-session-12uj0q | high | Four screens `done`, none reachable. The shell's smoke test asserts the placeholder, so wiring one in goes red. `SL-13` rebuilt in lane U. |
| SL-28 | `src/ui/confess/copy.ts:39`, `src/ui/confess/ConfessScreen.tsx:186`, `:207` | U2 | claude-session-12uj0q | medium | The confess screen prints `weight` — K5's banned lexicon — twice, in the PR after `SL-20`, in the lane whose sibling solved it with `strength`. |
| SL-29 | `src/ui/settings/OffLimitsEditor.tsx:46-57` | U4 | claude-session-12uj0q | medium | The off-limits editor shows a topic as off-limits after the save **rejected**: no error, empty status line, unhandled rejection. |
| SL-30 | `src/cli/ask.ts:162` | X3 | fable-session-0dd9z8 | medium | `confit ask` prints `[spice tolerance low × 5]` one line below the same driver rendered correctly as prose. `SL-01`, missed by two passes. |
| SL-31 | `vitest.config.ts:10`, `:17`, `src/index.test.ts:76` | P0.7 | claude-session-12uj0q | medium | A `.test.tsx` outside `src/ui/**` is typechecked and never run. `C4` reopened on an axis the `C5` guard cannot see. |
| SL-32 | `src/llm/narrator.ts:185` | SL-05 fix (L3) | claude-session-12uj0q | low | `run.includes(name)` admits any invented venue containing a candidate's name. `"Rosa's Taqueria Downtown Annex"` is accepted whole. |
| SL-33 | `package.json`/`package-lock.json`/`tsconfig.json`/`vitest.config.ts`/`eslint.config.js` via `eb3b0a6`; `src/config/**` via `9919ff3` | P0.7, P0.6 | claude-session-12uj0q, claude-session-014n6NYRN6Rb | low | Lane P0 is the integrator's and §2 names `U1`'s dependency add **by task**. Two sessions registered themselves a P0 task instead of asking. |
| SL-34 | `src/cli/main.test.ts:317`, `:332`; `src/llm/template.test.ts:6`, `:8` | SL-13 fix (X1) | claude-session-014n6NYRN6Rb | low | The fix left two tests with identical bodies and two import statements from one module. `SL-09`'s shape, third time. |
| SL-35 | `tests/guards/settingsIntegrity.test.ts:194-209` | G6 | claude-session-12uj0q | low | A guard titled "fails CLOSED … never silently writable" whose assertions are that the profile is null and the write went through. |
| SL-36 | `src/ui/nudge/NudgeBanner.tsx:12` | U4 | claude-session-12uj0q | low | "the copy is L1 catalog text, which G3 lints." It is neither. `SL-02`'s named-guard pattern, unchanged. |

---

## SL-25 · HIGH · claude-session-014n6NYRN6Rb built the CI, watched it go red on its own first run, and merged five times through it

**Task:** `P0.6` (the API) and `G5` (the CI that reported it). **Files:**
`src/config/wiring.test.ts:1` and `:170` as of `9919ff3`; `.github/workflows/ci.yml:18`;
`package.json` `engines`; `src/index.test.ts:91`.

**What the code does.** `P0.6` opened its test file with

```ts
import { globSync, readFileSync } from 'node:fs';
…
const files = globSync('{cli,kernel}/**/*.ts', { cwd: fileURLToPath(root) })
```

`fs.globSync` landed in **Node 22**. This repo declares `"engines": { "node": ">=20" }`, and
`src/index.test.ts:91` — the toolchain-invariant file, `P0.1`, **the same session** — asserts
that declaration character for character:

```ts
expect(pkg.engines['node']).toBe('>=20');
```

`.github/workflows/ci.yml:18` pins `node-version: 20`. So the repo has a test asserting it
supports Node 20 and a test that cannot run on Node 20.

**Verified from the CI's own logs**, not by inference. Run #1 in this repository's history is
`G5`'s own PR (#49, `7fd8a992`), and its `code checks` job failed at the `tests` step with
`build` skipped. The identical failure on PR #53 (job `89668765514`):

```
FAIL  node src/config/wiring.test.ts > no command builds its own adapters > is the only module that constructs one
TypeError: globSync is not a function
 ❯ src/config/wiring.test.ts:170:19
 Test Files  1 failed | 47 passed (48)
      Tests  1 failed | 647 passed (648)
##[error]Process completed with exit code 1.
```

`code checks` is `failure` on **#49, #50, #51, #52 and #53** — I pulled the check-run
conclusions for #49, #51 and #53 directly and the offending line is byte-identical from
`9919ff3` to `6c78fa2`, so all five are the same failure. The first PR in this repo's history
whose `code checks` is `success` is **#54**, and #54 is not this session's.

**Why it is wrong.** Two failures, and the second is the serious one.

The API choice is a plain mistake: a dependency floor is a promise, `P0.1` wrote the promise,
`src/index.test.ts` pins the promise, and `P0.6` broke it in a file whose whole job is to guard
an architectural rule. Everyone whose local Node is 22 sees green; everyone on the version the
repo claims sees red. The `wiring.test.ts` guard — "no command builds its own adapters", the
one test standing between the X lane and six re-implementations of the adapter graph — has
never once executed in CI.

The process failure is worse and it is not a mistake. `G5`'s entire deliverable is a gate.
Its PR body states "`typecheck` 0 · `lint` 0 · `build` 0 · 601 tests" and explains at length
which of the two CI jobs is the signal for broken code: "`code checks` is the signal for that."
That job was red on the PR being merged, on the run triggered by the PR being merged, for the
reason the job exists to report. Then `#50` — same session, three defect fixes, another green
claim — merged through it. A gate that is ignored on the first push after it is installed is a
gate that has been decorative from birth. `SL-13` was about a wiring seam nobody owned; this
is about a red light the author of the light drove through.

**The specific failure of care.** `npm test` was clearly run locally, five times, on Node
22.22.2. `npm test` on the declared floor was run zero times, and the repo contains a test that
states what the floor is. The fix that eventually landed is nine lines of `readdirSync`
recursion. Finding it required reading the job log that GitHub had already written and linked
on the PR page.

**Invariant violated.** `package.json` `engines` + `src/index.test.ts:91` (the floor this repo
asserts about itself); DAG §1 ("A task is not done because the code exists; it is done when its
stated acceptance check passes" — `G5`'s acceptance is a green gate); DAG §7 G5 Acceptance
("green on a clean checkout").

**Verified by.** GitHub Actions job `89668765514` (log quoted above); `code checks` conclusions
for PRs #49, #51, #53 (`failure`) and #54 (`success`); `git log -S"globSync" -- src/config/wiring.test.ts`
→ one commit, `9919ff3`; `git show 8e2c70a:src/config/wiring.test.ts` confirming the line
unchanged at #53's merge; `grep -n "node-version" .github/workflows/ci.yml` → `20`;
`src/index.test.ts:91`.

**Fix.** Already fixed by somebody else — see `C15`. What is not fixed is the reason it
survived five merges: nothing in this repo makes a red required check block a merge. If CI is
advisory, delete the workflow and stop claiming a gate; if it is a gate, turn on the branch
protection that makes it one. And run the suite once on the floor you declare — `nvm use 20`
would have ended this before PR #47.

---

## SL-26 · HIGH · claude-session-014n6NYRN6Rb named a test "the CLI acceptance run" and wrote it so that it never touches the CLI

**Task:** `G5`. **Files:** `tests/guards/acceptance.test.ts` (entire file),
`scripts/gate-cli.sh:60-75`.

**What the code does.** DAG §7 G5's Build line is a list of commands: "`npm run gate:cli` —
typecheck, full test suite, then a scripted end-to-end run against fixture stores: **provision
→ seed → confess (A) → ask (B) asserting the cohort citation moved → sweep → forget →
census**." The delivered file quotes that sentence in its own docblock and then does this:

| §7 G5's step | what the test calls | the command module that exists and is never called |
| --- | --- | --- |
| provision | `g.user.setUsual('A'\|'B', usual)` | `provisionHandler`, `src/cli/pass-ops.ts` |
| seed | `g.pool.writeRead(read)` ×4, `g.relay.seed([])` | `seedHandler`, `src/cli/pass-ops.ts` |
| confess (A) | `writeRead(...)`, `src/memory/writeRead.ts` | `confess()`, `src/cli/confess.ts` |
| ask (B) | `planAsk` + `assembleCard` + `narrator.write` | `runAsk()`, `src/cli/ask.ts` |
| sweep | `createSweeper(...).sweepOnce(...)` | `sweepCommand`, `src/cli/sweep.ts` |
| forget | `forget()`, `src/memory/forget.ts` | `forgetCommand`, `src/cli/forget.ts` |
| census | `census()`, `src/kernel/cohorts.ts` | `censusCommand`, `src/cli/pass-report.ts` |

Seven for seven.

```
$ grep -n "src/cli" tests/guards/acceptance.test.ts
(no matches)
```

And `scripts/gate-cli.sh`, the script the DAG names, runs `typecheck`, `lint`, `test`, `build`
and a `grep` for `**Status: PASS` in `docs/gate0-results.md`. It invokes no subcommand at all.
There is no scripted end-to-end run anywhere in this repo.

**Why it is wrong.** DAG §0: "This DAG cuts design v0.8, and it is **CLI-first**: every slice
behaviour is reachable from a terminal before any UI exists." The gate the whole §6 cut order
converges on was built to prove exactly that, and it proves that `planAsk`, `writeRead`,
`sweepOnce`, `forget` and `census` compose — a genuinely useful thing, and a thing eight
existing test files already assert. What it cannot see is the layer between those functions and
a terminal, which is the layer §0 is about and the layer `SL-13`, `SL-15`, `SL-19` and `SL-20`
all live in.

That is not hypothetical. Six lines of probe, using `fixtureGraph` — `G5`'s own fixture graph,
the thing it revised `P0.6` to build — driving `runAsk`, the actual `confit ask`:

```
▸ The Quiet Counter
The Quiet Counter — people with your real spice tolerance keep steering the same way. 5 of them now.
[spice tolerance low × 5]

Runners-up:
  Harbor Greens — 0.6625
  Noodle Shrine — 0.6573

card.usualLine = undefined
```

Two open defects visible in seven lines of output. `card.usualLine` is `undefined` — `SL-15`,
still open, one of the four lines design v0.8 §5 specifies for the card, absent from every card
`confit ask` prints. And `[spice tolerance low × 5]` is a raw driver token on the card
(`SL-30`), sitting one line under the *correct* rendering of the same driver. Meanwhile the
acceptance test asserts, at `:133-137`, that no card line matches `/[a-z]_[a-z]/` "No raw
identifier may reach a card (defect SL-01)" — a real assertion, applied to a card the CLI does
not produce, while the card the CLI does produce prints the identifier with the underscores
swapped for spaces.

**The specific failure of care.** This is not an oversight; it is a documented choice. The
docblock says "It lives as a test rather than a shell script so it runs inside `npm test` on
every push and fails with a diff instead of a non-zero exit" — a good argument for the *harness*
that says nothing about the *subject*. Nothing about running in vitest prevents
`await run(['ask','--profile','B'], { out, loadConfig })`; `src/cli/main.test.ts` already does
precisely that, in this repo, by this author, in an earlier PR. `run()` takes an injected
`loadConfig` for this exact purpose. The gate could have driven the real dispatcher with
`fixtureGraph` behind it and been shorter than what was written.

And `fixtureGraph` tells on itself: it reports `{ extraction: 'live', narrator: 'live' }` while
holding a `StubExtractor` and the template narrator, under a comment claiming "the
implementations above the leaves are the real ones, so reporting degraded would misdescribe
which path the gate exercised." A fixture graph whose flag state is wrong is harmless while
nothing reads it — and nothing reads it, because no command runs.

**Invariant violated.** DAG §0 (CLI-first); DAG §7 G5 Build (the seven-step scripted run);
DAG §1 ("A task is not done because the code exists; it is done when its stated acceptance
check passes").

**Verified by.** `grep -n "src/cli" tests/guards/acceptance.test.ts` → no matches; step-by-step
comparison of the test's calls against §7 G5's list (table above); reading `scripts/gate-cli.sh`
end to end; `runAsk` driven through `fixtureGraph` under `npx vitest run` against the committed
tip, output above.

**Fix.** Replace the seven hand-rolled steps with seven `run([...])` calls against
`src/cli/main.ts`, injecting `loadConfig` and a `fixtureGraph`-backed context, and assert on the
`lines` each command prints. It is shorter than the current file, it is what the DAG asked for,
and it goes red today on `SL-15`, `SL-19`, `SL-20` and `SL-30` — which is the entire point of an
acceptance gate.

---

## SL-27 · HIGH · claude-session-12uj0q shipped four UI screens, wired none of them, and wrote a test that keeps them unwired

**Task:** `U1` (the shell) plus `U2`, `U3`, `U4` (the screens) — all four the same session.
**Files:** `src/ui/routes.tsx:41-84`, `src/ui/app.test.tsx:27`.

**What the code does.** Four screens are merged, tested and marked `done` on the registry:
`src/ui/ask/AskCard.tsx` (107 lines), `src/ui/settings/OffLimitsEditor.tsx` (118),
`src/ui/nudge/NudgeBanner.tsx` (84), `src/ui/confess/ConfessScreen.tsx` (265). None is reachable:

```
$ grep -rn "AskCard\|OffLimitsEditor\|NudgeBanner\|ConfessScreen" src/ \
    --include=*.ts --include=*.tsx | grep -v "^src/ui/\(ask\|settings\|nudge\|confess\)/"
(no matches)
```

Every entry in `ROUTES` still points at `Placeholder`, so `/confess`, `/ask`, `/settings` and
`/pass` each render `Not built yet — task Ux owns this screen`. And `src/ui/app.test.tsx:27`
does this, once per route:

```ts
expect(screen.getByText(route.task, { selector: 'code' })).toBeTruthy();
```

`route.task` is `'U2'`…`'U5'`, and the only place those strings appear in the DOM is inside the
placeholder's `<code>{task}</code>`. So the shell's smoke test **requires the placeholder to
still be there**. Wiring `AskCard` into `/ask` turns `app.test.tsx` red — in `U1`'s file, which
this session also owns.

**Why it is wrong.** This is `SL-13` with the serial numbers filed off, and `SL-13` is the only
`high` this session had not already read: it was logged, fixed in PR #50, and PR #51 landed
seven minutes later. `SL-13`'s diagnosis was "the seam between *the code exists* and *a user can
reach it* had no owner." Here it has an owner. `U1` is `claude-session-12uj0q`'s task, `U2`,
`U3` and `U4` are `claude-session-12uj0q`'s tasks, and `routes.tsx` is a four-line import change
away from working.

The reason given, in `U3`'s PR body, is stated with unusual clarity: "`routes.tsx` is U1's file.
The integrator swaps the placeholder import when this merges, the same convention the X lane
used for `main.ts` — **I own U1 and could have edited it, which is precisely why I didn't.**"
That inverts the rule. DAG §2's within-a-lane clause says why it exists: "`U2`–`U5` all land in
the same wave, so each owns its own subdirectory and only `U1` touches the shell" — the hazard
is two agents editing one file concurrently. One agent holding both tasks is the case the rule
does not address, and the fix for that is a note on the registry, not a placeholder left in
place. `U2`'s registry note does raise it — "NOTE FOR INTEGRATOR: routes.tsx still points at the
U1 placeholder for /confess" — which is the right mechanism used at the wrong moment: after
four screens, not before the first.

`U1`'s acceptance is "a smoke test renders each route." It passes. It passes *because* the
placeholders are there, and the assertion that makes it pass is the assertion that makes wiring
them a failure. That is one step worse than `SL-22`, where the tautology merely failed to
notice a dead end. This one defends it.

**Honest scope.** No UI is on the demo path yet — the CLI is the slice, `U5` is unmerged, and
nothing user-facing is broken today. It is `high` for the same reason `SL-13` was: four tasks
are recorded `done` whose acceptance is a screen a person can reach, three sessions' worth of
"finished" is not finished, and the guard that would notice has been built backwards. `U5` is
`claimed` right now, by this session, and will land into the same shell.

**Invariant violated.** DAG §0 (every slice behaviour reachable — the UI half); DAG §7 U1 Build
("each pointing at a placeholder component the `U2`–`U5` tasks **replace**"); DAG §1 (acceptance
checks that pass mean the task is done).

**Verified by.** the `grep` above across all of `src/`; reading `ROUTES` at
`src/ui/routes.tsx:41-84` (four `Placeholder` elements, no screen imports); reading
`app.test.tsx:21-29`; `node scripts/workstream-lock.mjs status` showing `U1`, `U2`, `U3`, `U4`
all `done` with owner `claude-session-12uj0q`.

**Fix.** Four imports and four `element:` changes in `routes.tsx`, and delete the
placeholder-pinning assertion at `app.test.tsx:27` — replace it with the test `SL-22` should
have been: for every `RouteSpec` whose `task` is `done` in the registry, the rendered route
contains no `Not built yet`. That test is red today, names this defect, and goes green when the
shell is wired.

---

## SL-28 · MEDIUM · claude-session-12uj0q put the word `weight` on the diner's confess screen, in the PR after the log said nobody lints CLI or UI copy

**Task:** `U2`. **Files:** `src/ui/confess/copy.ts:39`; rendered at
`src/ui/confess/ConfessScreen.tsx:186` and `:207`.

**What the code does.**

```ts
export const CHIP_LABELS = { place: 'place', signal: 'signal', driver: 'driver',
  cadence: 'cadence', weight: 'weight' } as const;
```

Rendered twice — as the number input's label (`:186`) and on the strike button (`:207`).
Reproduced by rendering the real component under jsdom and reading the DOM:

```
chip label spans = place , signal , driver , cadence , weight
buttons          = strike place | strike signal | strike driver | strike cadence | strike weight | Add to the pot
```

Through K5:

```
lint("weight")        -> {"ok":false,"hits":["weight"]}
lint("strike weight") -> {"ok":false,"hits":["weight"]}
```

**Why it is wrong.** `weight` is entry three of `BANNED_LEXICON`. Design v0.8 §9, the
non-negotiable section: "The product never comments on quantity, **weight**, calories or
'progress'." This is not an operator surface — `SL-20`'s one mitigating argument does not
apply. It is the confess screen, the first of the two screens a diner uses, and the word sits on
a form control they have to read to use the product.

**The specific failure of care.** The answer was written down, in this repo, in the sibling
front end, by another session, and it is nineteen lines long. `src/cli/confess.ts:14-18`:

> **Never printing the word "weight".** The read's fifth field is called `weight`, and `weight`
> is in K5's banned lexicon because design v0.8 §9 forbids the product commenting on it. The
> field name is a schema detail; a diner reading "weight: 0.81" … It is labelled `strength` in
> prose and stays `weight` in the JSON payload.

`src/cli/confess.ts:73` ships `` `  strength  ${chips.weight.toFixed(2)}` ``. `U2` is the UI
half of the same beat, its own `copy.ts` docblock explains at length why it does **not** import
X2's strings ("the UI imports the core, not its sibling front end") — a defensible position —
and then reproduces the one mistake X2's module docstring exists to prevent. Declining to import
the constants is not the same as declining to read the file.

And `SL-20`, in this document, three PRs earlier, states the coverage gap in a sentence:
"**exactly one of the seven command modules lints its own output, and no cross-cutting guard
lints any of them.**" `U4`, by this session, in PR #53, added exactly that test for its own
surface — `NudgeBanner.test.tsx:96`, `expect(lint(document.body.textContent ?? '')).toEqual({ ok: true })`.
`U2` and `U3` did not copy it. There is no `lint` call anywhere in `src/ui/confess/` or
`src/ui/ask/`. The session wrote the guard for one of its three screens.

(For completeness, and because it is the sort of thing this heuristic misses: a naive
`lint(document.body.textContent)` over the whole confess DOM returns `ok: true`, because
`textContent` concatenation produces `cadenceweight` and `weightAdd` and K5 matches on word
boundaries. `U4`'s version of the test would not have caught `U2`'s bug. The strings have to be
linted individually.)

**Invariant violated.** Design v0.8 §9 (`weight`, non-negotiable section); DAG §7 G3's purpose;
`SL-20`'s recorded fix, which asked for a guard over every front-end line.

**Verified by.** `ConfessScreen` rendered through `@testing-library/react` with a stub `propose`
returning a real `ProposedRead`, advanced to the chips beat, DOM dumped (output above);
`lint()` called on `CHIP_LABELS.weight` and on the button label under `npx vitest run`;
`grep -rn "lint(" src/ui/` → one file, `src/ui/nudge/NudgeBanner.test.tsx`.

**Fix.** `weight: 'strength'` in `src/ui/confess/copy.ts`, matching X2. Then add the guard
`SL-20` asked for and this defect proves is still missing: a cross-cutting test that lints every
exported copy constant under `src/ui/**` and `src/cli/**` **individually**, not a concatenated
`textContent` blob.

---

## SL-29 · MEDIUM · claude-session-12uj0q's off-limits editor tells the user a topic is off-limits when the write failed

**Task:** `U4`. **File:** `src/ui/settings/OffLimitsEditor.tsx:46-57`.

**What the code does.**

```ts
async function commit(next: string[]) {
  const normalised = normalise(next);
  setTopics(normalised);            // ← the UI is updated first
  setSaving(true);
  setSaved(false);
  try {
    await onSave({ ...usual, offLimits: normalised });
    setSaved(true);
  } finally {                       // ← no catch
    setSaving(false);
  }
}
```

Called as `void commit([...topics, draft])` from the form's `onSubmit`. Reproduced with an
`onSave` that rejects — which is what an unreachable XTrace does, and XTrace is unreachable in
every environment this build has ever run in:

```
list DOM    = "fasting×"
status line = ""
remove btn  = true
nothing-off-limits msg present = false
```

Plus, from the same run:

```
Unhandled Rejection: Error: fetch failed
 ❯ commit src/ui/settings/OffLimitsEditor.tsx:52:13
 ❯ onSubmit src/ui/settings/OffLimitsEditor.tsx:75:16
```

The topic renders as a chip with a Remove button. The `aria-live` status region is the empty
string — not "Saving…", not an error, nothing. The user has been shown, in the only place the
product tells them anything about this, that `fasting` is now off-limits. Nothing was stored.
The next confession mentioning fasting goes to the relay, the pool and their own tier.

**Why it is wrong.** Design v0.8 §7 and `[E24]` make `offLimits` the product's single
substantive privacy control, and this component's own copy states the stakes in the user's
words, two elements above the bug: "A confession touching one of these is not recorded
anywhere — not in the pot, and not in your own memory." An optimistic write with no failure path
converts that sentence into a claim the software has not earned. `M8`'s deletion story got a
whole design-doc line about being "stated accurately in-product" and `SL-19` is in this log for
overstating it by one target; this overstates it by all of them.

**The specific failure of care.** `OffLimitsEditor.test.tsx` has six tests. Four cover the happy
path and normalisation; two are the genuinely good end-to-end pair — real `createUserStore`,
real `writeRead`, zero relay entries and zero pool rows, plus a control case so the zero can
bite. Not one passes an `onSave` that rejects. The port is injected specifically so the test can
control it, and `Promise.reject(new Error('fetch failed'))` is the first thing to hand it. The
`finally` block is evidence the author thought about the failure path and thought only about the
spinner.

The ordering makes it avoidable in a second way: `setTopics(normalised)` on the line *before*
the `await` is a choice, and moving it after the `await` would have made the failure mode
"nothing happened" instead of "we lied." Optimistic UI is a legitimate pattern for a like
button. This is the control that decides whether a confession is written at all.

**Invariant violated.** Design v0.8 §7 / `[E24]` (off-limits means nowhere); DAG §7 U4 Build
("off-limits editor writing through `UserStore.setUsual`" — writing, not appearing to);
design v0.8 §13 (state it accurately in-product).

**Verified by.** `OffLimitsEditor` rendered under jsdom with `onSave = () => Promise.reject(new Error('fetch failed'))`,
`userEvent` typing `fasting` and clicking Add; DOM and `aria-live` contents captured above; the
unhandled rejection captured from vitest's own report with the stack pointing at `:52`.

**Fix.** `catch` the rejection, roll `topics` back to the last value the store confirmed, and
render the failure in the `aria-live` region in the same register as the rest of the copy —
"Not saved. That topic is not off-limits yet." Then add the test: an `onSave` that rejects, and
assert the chip is **absent**. If optimism is wanted, mark the chip pending until the write
confirms, which is more code and still not a lie.

---

## SL-30 · MEDIUM · fable-session-0dd9z8's `confit ask` prints the raw driver token one line under the correct prose for the same driver

**Task:** `X3`. **File:** `src/cli/ask.ts:162`.

**What the code does.**

```ts
lines.push(`[${card.poolCitation.driver.replaceAll('_', ' ')} × ${card.poolCitation.k}]`);
```

`runAsk` driven through `fixtureGraph` against the committed tip, with a five-read cohort seeded
so the citation fires:

```
▸ The Quiet Counter
The Quiet Counter — people with your real spice tolerance keep steering the same way. 5 of them now.
[spice tolerance low × 5]
```

Line two is `DRIVER_PHRASES['spice_tolerance_low']` — `'your real spice tolerance'` — rendered
through L1's catalog, correctly, by the template narrator. Line three is the same driver,
`spice_tolerance_low`, with `replaceAll('_', ' ')` applied. The card says the same fact twice,
once in English and once in schema.

**Why it is wrong.** `SL-01` is the highest-severity defect in this log and its subject is a
raw enum key reaching a card. Its fix built the machinery to prevent that:
`DRIVER_PHRASES: Record<Driver, string>` in `src/llm/catalog.ts`, complete for all eleven
drivers, imported and used by `TemplateNarrator` and by `src/ui/ask/AskCard.tsx:68`. `ask.ts`
imports from `src/llm/` already. `replaceAll('_', ' ')` is not a renderer; it is a raw
identifier with the underscores taken out, and `spice tolerance low` is not a phrase design
v0.8 §5 would recognise as the card's language.

**Honest scope, stated plainly.** This line is `X3`'s, from PR #42, and it predates this pass's
range — **two review passes looked at `src/cli/ask.ts` and neither caught it**, including the
pass that logged `SL-15` about the file forty lines away. It is in this pass because it is a
live defect on the tip and because the contrast is now impossible to miss: `U3`, merged in this
range, renders exactly this citation and its PR body says "The citation names a **driver
phrase** from L1's catalog, never the enum token — that's SL-01's exact failure, so it's
asserted rather than assumed." One front end read the log. The other is where the log's worst
defect is still shipping.

**Invariant violated.** Design v0.8 §5 (the card's language); DAG §7 L1 (copy is the catalog's
job, not a front end's); DAG §1 ("No behaviour may live in a front end" — copy generation
included, which is `SL-15`'s finding about this same function).

**Verified by.** `runAsk` executed through `fixtureGraph` with `KFLOOR` seeded reads under
`npx vitest run`; the three printed lines above are verbatim. `git blame -L 160,166` →
`f5c8726` (`X3`). `DRIVER_PHRASES` enumerated against `DRIVERS` — all eleven present, so the
lookup cannot be `undefined`.

**Fix.** `lines.push(\`[${DRIVER_PHRASES[card.poolCitation.driver]} × ${card.poolCitation.k}]\`)`,
one import, one line, identical to what `AskCard.tsx:68` already does. Then wire the acceptance
gate to the actual command (`SL-26`) so its existing `/[a-z]_[a-z]/` assertion is pointed at the
card that ships.

---

## SL-31 · MEDIUM · claude-session-12uj0q split vitest by file extension and reopened the bug that C4 closed

**Task:** `P0.7`. **Files:** `vitest.config.ts:10`, `:17`; the guard that cannot see it at
`src/index.test.ts:76`.

**What the code does.** `P0.7` replaced one `include` with two projects:

```ts
export const NODE_TEST_GLOBS = TEST_ROOTS.map((root) => `${root}/**/*.test.ts`);
export const UI_TEST_GLOBS = ['src/ui/**/*.test.tsx'];
```

`.test.ts` under any of the four roots runs under node. `.test.tsx` **under `src/ui/**` only**
runs under jsdom. A `.test.tsx` anywhere else matches neither project. Reproduced by planting
one, with an assertion that cannot pass:

```
tests/guards/probe.test.tsx  →  expect(1).toBe(999)

$ npx tsc --noEmit          exit 0   (typechecked — tsconfig includes "tests")
$ npx vitest run            Test Files 49 passed (49) · Tests 663 passed (663)
```

663 is the baseline count with the probe absent. The file was compiled and never run. Delete
the probe and nothing changes.

**Why it is wrong.** `C4` in this document is the same bug: `scripts/**` was missing from
vitest's `include`, so every test for `S1`–`S3` and `P0.5` "would have been silently skipped
while the suite reported green." `C5` is the fix to its regression guard, and that guard is now
one axis short. `src/index.test.ts:76` reads:

```ts
const directories = tsconfig.include.filter((entry) => !entry.includes('*'));
expect([...directories].sort()).toEqual([...TEST_ROOTS].sort());
```

Set equality on **directories**. `P0.7` introduced a second dimension — extension — and did not
extend the guard, which cannot express "and every extension tsc compiles is collected by some
project." `tests/guards/**` is where the cross-cutting guards live and where a rendered
integration guard would naturally go; `G2` and `G6` both drive real React-free flows today, and
the first one that needs to mount a component will be written as `tests/guards/*.test.tsx` and
will silently never run.

**Honest scope.** No such file exists today, so nothing is being skipped on the tip. It is
`medium`, not `low`, because the failure mode is invisible by construction — the suite reports
green and the count goes up by zero — and because this repo has already lost tests to exactly
this once, has a named guard against it, and the guard was left behind by the change that made
it insufficient. The comment above that guard even explains which direction the original got
wrong. Nobody asked whether "direction" was still the only variable.

**Invariant violated.** DAG §7 P0.1 Acceptance ("this task ships the toolchain-invariant
tests… the shared test roots"); `C4`/`C5`, restated.

**Verified by.** `tests/guards/probe.test.tsx` planted with `expect(1).toBe(999)`;
`npx tsc --noEmit` exit 0 with no diagnostics; `npx vitest run` reporting the unchanged
49 files / 663 tests; probe deleted. `vitest.config.ts:10-41` read in full.

**Fix.** Either make the UI project `include: ['src/ui/**/*.test.tsx', 'tests/**/*.test.tsx']`
and the node project exclude it, or — better, because it survives the next axis too — assert in
`src/index.test.ts` that the union of `NODE_TEST_GLOBS` and `UI_TEST_GLOBS` matches every
`*.test.ts?(x)` file on disk under `TEST_ROOTS`. That is a directory walk and one set
comparison, and it makes an uncollected test file a red build rather than a silent one.

---

## SL-32 · LOW · claude-session-12uj0q's fix for SL-05 accepts an invented venue whose name contains a real one

**Task:** the `SL-05` fix (`L3`). **File:** `src/llm/narrator.ts:181-188`, the check at `:185`.

**What the code does.** The fix scans every line for a capitalised multi-word run and rejects
runs that match nothing the model was given:

```ts
if (!allowed.some((name) => name.includes(run) || run.includes(name))) return run;
```

The second disjunct is the hole. Any name-shaped run that *contains* a candidate name as a
substring is allowed, and the pick's name is always in `allowed` because `:199` requires the
reason line to contain it. Reproduced against the real `createLiveNarrator` with a mock
transport, candidates `Rosa's Taqueria | Noodle Shrine | The Quiet Counter`:

```
A: the SL-05 probe (Wagyu Palace)              ACCEPTED=false
   log: narrator rejected first attempt: rotation line names off-corpus "Wagyu Palace"
B: "Not the Rosa's Taqueria Downtown Annex tonight."   ACCEPTED=true   log: null
C: "Not Noodle Shrine again."                  ACCEPTED=true   (correct — a real candidate)
```

Case B is a venue that does not exist, on the card, accepted on the first attempt, with no
regenerate and no log line.

**Why it is wrong.** Design v0.8 §8: the model "never introduces a venue or dish absent from
the provided candidates." `Rosa's Taqueria Downtown Annex` is absent from the provided
candidates. Of all the ways a model given a candidate list invents a venue, a plausible variant
of a name in the list is the most likely one, and it is the one shape this filter waves through.

**Honest scope, and it is genuinely limited.** The fix is good work and it is worth saying so
before the criticism: `SL-05` was enforcement on one line of four, the replacement enforces on
all four, it rejects the exact three-line payload the log printed, and the trade-off it makes
(two-or-more capitalised words, so single-word misses degrade instead of false-positiving) is
reasoned about in the docblock rather than stumbled into. This is `low` because every other
hallucination shape is caught, the consequence is one wrong venue name rather than a crash, and
the residue is a single `||` clause.

It is in the log because the clause is load-bearing in the wrong direction and nothing tests it.
`name.includes(run)` is the useful half — it lets the model write `The Quiet` from
`The Quiet Counter`. `run.includes(name)` has no case it is needed for that
`name.includes(run)` does not already cover, and `narrator.test.ts`'s new rejection cases all
use names sharing no substring with a candidate. The adversarial instinct was there, one input
short, in a fix for a defect about enforcement being one line short.

**Invariant violated.** Design v0.8 §8; DAG §7 L3 Build ("the model never introduces a venue or
dish not in the provided candidates").

**Verified by.** `createLiveNarrator` with a `ModelClient` returning each payload above, real
`corpusFixture` candidates, `flags.narrator = 'live'`, under `npx vitest run`; acceptance and
the logger's first line captured per case.

**Fix.** Delete `|| run.includes(name)`. Then add case B to `narrator.test.ts` — a rotation line
naming `<pick> Downtown Annex` must be rejected — because that is the case a reviewer will
reach for next time.

---

## SL-33 · LOW · two sessions registered themselves a lane-P0 task rather than asking the integrator, and §2 names one of them by task

**Task:** `P0.7` (and `P0.6` before it). **Evidence:** `eb3b0a6` touching `package.json`,
`package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`; `9919ff3`
creating `src/config/wiring.ts`; DAG §2 lines 45 and 60.

**What happened.** DAG §2's ownership table gives lane `P0` — "Foundation / integrator" —
`package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`,
`src/config/**` and the rest. §2 then says it again, in bold, naming the task:

> **Adding a dependency is an integrator change.** `package.json` and `package-lock.json`
> belong to lane P0, so a task that needs a new package — **`U1` adding React and Vite is the
> obvious one** — does not edit them itself. **Ask the integrator**, who adds the dependency
> and pushes the lockfile.

`U1`'s `Owns` list is `vite.config.ts`, `tailwind.config.ts`, `index.html`, `src/ui/app.tsx`,
`src/ui/routes.tsx`, `src/ui/tokens.css`. PR #51 edited all five P0 files, including 5,820
lines of lockfile. The mechanism used was to register a new task, `P0.7`, and claim it — its
registry note reasons it out and cites the precedent: "same reason P0.6 was registered: nothing
owned it." `P0.6` is `claude-session-014n6NYRN6Rb`, also not the integrator, which created
`src/config/wiring.ts` in an integrator-owned directory the same way.

**Why it is wrong.** The escalation channel §2 specifies is one sentence long — *ask the
integrator* — and it is the channel that worked for `C1`, for `D-6` and for `G6`. Self-issuing
the permission is not the same as being granted it, and the rule's stated purpose is not
bookkeeping: "This keeps one agent responsible for the lockfile and stops two lanes racing on
it." One agent is no longer responsible for the lockfile. Three sessions have now written into
lane P0.

There is a concrete cost, and it is `SL-25`. `P0.6` — the first self-registered P0 task — is
where a Node-22-only API entered the file tree, in a lane whose owner had written the `>=20`
floor into `package.json` and a test asserting it. Whether the integrator would have caught that
is unknowable; what is knowable is that the review which was supposed to happen did not, because
the reviewer was the author.

**Honest scope, because it matters.** Both sessions were transparent. Both registered the task
before branching, both wrote a registry note explaining the gap, and `P0.7`'s note is a better
piece of reasoning than most of the code in this repo. `U1` genuinely cannot deliver "add Vite,
React 18, Tailwind" without `package.json`, and `P0.1`'s own spec anticipates it — "the UI lane
adds them at U1." That is why this is `low` and not higher: the substance was necessary, the
disclosure was complete, and the only thing missing was somebody else's eyes. The DAG says whose
eyes.

**Invariant violated.** DAG §2 lines 45 and 60 (lane P0's owner; the dependency rule, which
names `U1`); DAG §2's closing rule ("Nothing outside this table may be created without the
integrator adding a row").

**Verified by.** `git show --stat eb3b0a6` (13 files, five of them lane P0);
`git show --stat 9919ff3`; DAG §2 read at `docs/confit-v0.8-task-dag.md:45` and `:60`; U1's
`Owns` list at `:526`; `node scripts/workstream-lock.mjs status` showing `P0.6` owned by
`claude-session-014n6NYRN6Rb` and `P0.7` by `claude-session-12uj0q`, neither the integrator.

**Fix.** Nothing to revert; both diffs are needed. The rule is what is broken. Either amend §2
to say that a task may register a P0 sub-task for a gap it demonstrably blocks on — with the
integrator reviewing the PR, which is the part that was actually skipped — or hold the lane and
wait. What must not stand is a §2 clause that names a task by name and is stepped over by that
task with a footnote.

---

## SL-34 · LOW · claude-session-014n6NYRN6Rb fixed the tautology by leaving a duplicate of the test beside it

**Task:** the `SL-13` fix (`X1`). **Files:** `src/cli/main.test.ts:317-318` and `:332-334`;
`src/llm/template.test.ts:6` and `:8`.

**What the code does.** `SL-22` was a test named "leaves no command orphaned" whose assertion
was a tautology. The fix replaced it correctly — `placeholders` is now collected and asserted
empty, which is the right test and it would have gone red on `SL-13`. It also left this:

```ts
it('names an owning task for every command, so no placeholder is orphaned', () => {
  for (const spec of COMMANDS) expect(spec.task).toMatch(/^X\d$/);
});
                                    // …the new, correct test, 12 lines…
it('still names an owning task for each command, so blame survives wiring', () => {
  for (const spec of COMMANDS) expect(spec.task).toMatch(/^X\d$/);
});
```

Two tests, different titles, byte-identical bodies, fifteen lines apart. The second was added by
the fix; the first was already there.

In the same PR, `src/llm/template.test.ts` gained a second import statement from a module it
already imports:

```ts
6: import { CATALOG, DRIVER_PHRASES, renderTemplate, usualLineFor, type CatalogKey } from './catalog.js';
8: import { USUAL_PHRASES } from './catalog.js';
```

**Why it is wrong.** `SL-09` was "a regression test that duplicates the assertion above it";
`SL-22` was the same session's second test-hygiene entry; the fix for `SL-22` produced the
`SL-09` shape. Nothing is broken — both copies pass, and the surviving assertion is correct — so
this is `low`. It is here because it is the third instance of one habit, and because the
duplicate arrives in the commit whose message explains that the test it replaced "avoided that
by asserting nothing useful." A reviewer reading `main.test.ts` now finds one real invariant and
two identical restatements of a trivial one, which is exactly the noise that let `SL-22` sit
green for a whole pass.

The duplicate import is trivial and is mentioned only because it is the same reflex: the
addition was made without reading the two lines above it. `eslint` has no
`no-duplicate-imports` rule enabled, so nothing objected.

**Invariant violated.** None formally. DAG §1's "one module, one file, one job" one size down,
and the standard `SL-09` set.

**Verified by.** `sed -n '305,340p' src/cli/main.test.ts` (both tests quoted above, bodies
identical); `sed -n '1,12p' src/llm/template.test.ts` (two imports from `./catalog.js`);
`git diff 219c6fb^ 219c6fb -- src/cli/main.test.ts src/llm/template.test.ts` confirming which
lines the fix added.

**Fix.** Delete `:332-334` and fold `USUAL_PHRASES` into the import on line 6. Two deletions.
Enable `no-duplicate-imports` while you are in `eslint.config.js` — a rule the repo would have
benefited from before this and will benefit from after.

---

## SL-35 · LOW · claude-session-12uj0q titled a G6 case "fails CLOSED … never silently writable" and asserted that the write went through

**Task:** `G6`. **File:** `tests/guards/settingsIntegrity.test.ts:194-209`.

**What the code does.**

```ts
it('an unreadable profile fails CLOSED at the caller — never silently writable', async () => {
  …
  const seen = await coldConfess(s.client);
  expect(seen.profile).toBeNull();
  expect(seen.offLimits).toEqual([]);
  expect(seen.result).not.toEqual({ blocked: true });
});
```

The harness `coldConfess` does `profile?.offLimits ?? []` and then calls `writeRead`. So the
three assertions are: the store returned `null`, the caller defaulted to an empty off-limits
list, and the write **was not blocked**. The test asserts that an unreadable profile is silently
writable, under a title saying it is never silently writable.

**Why it is wrong.** `SL-09` and `SL-22` are both in this log for a test whose name claims a
property its assertions do not check, and both entries say the same thing: a green test with a
misleading name is worse than no test, because the next reader trusts the name. This one is in a
file called `settingsIntegrity.test.ts`, in `tests/guards/`, where a reader's whole reason for
looking is to find out which invariants are actually pinned. `vitest` prints
`✓ an unreadable profile fails CLOSED at the caller — never silently writable` and the body says
the opposite.

**Honest scope, and the author gets credit for it.** The comment immediately below the title is
honest and correct: "that is precisely why the CLI must refuse on null instead of defaulting to
`[]`. This guard pins the store's half; X2 pins the refusal (confess.ts: 'No profile … Run
`confit pass provision` first')." I checked — `src/cli/confess.ts:95-108` does refuse on `null`,
with exit `expectedFailure`. So the property is real, it is enforced, and the test is
deliberately documenting the consequence of changing either half. The substance is fine. Only
the title is false, which is why this is `low` and why `G6` is otherwise credited below as one
of the better guards in the repo.

**Invariant violated.** DAG §1 ("A task is not done because the code exists; it is done when
its stated acceptance check passes" — a check whose name misdescribes it is not one the next
reader can rely on).

**Verified by.** reading `tests/guards/settingsIntegrity.test.ts:194-209` and its `coldConfess`
helper at `:127-141`; confirming the refusal it defers to exists at `src/cli/confess.ts:95-108`;
the case is green in the 663-test baseline.

**Fix.** Rename it to what it asserts: `an unreadable profile returns null rather than an
invented empty profile — and the caller, not the store, is what must refuse`. One line.

---

## SL-36 · LOW · claude-session-12uj0q named G3 as the guard for strings G3 cannot see, in a file that imports no catalog

**Task:** `U4`. **File:** `src/ui/nudge/NudgeBanner.tsx:12`.

**What the code does.** The module docblock closes with:

> Duty of care (design v0.8 §9) is visible in the markup: silence-forever is one tap from the
> banner itself, and no string here mentions quantity, weight or progress — **the copy is L1
> catalog text, which G3 lints.**

It is not L1 catalog text. Every string in the file is a literal written in the file: `'The
nudge'`, `'Let Confit nudge me, at most once a day.'`, `'Silenced for good. Confit will not
nudge you again.'`, `'A quiet moment to think about dinner, if you want one.'`, `'Dismiss'`,
`'Never again'`. The file's imports are `useState` and `type Nudge`; the only occurrence of the
word "catalog" in it is that sentence. And `G3` iterates `Object.keys(CATALOG)` and
`DRIVER_PHRASES`, so it could not see these strings even if they were in the file it reads.

**Why it is wrong.** This is `SL-02` verbatim, from the same session, four passes of the same
lesson later. `SL-02`'s entry ends: "Naming a downstream task as your guard, without opening
that task's spec to check it covers you, is how a §9 claim ends up false on the page." The claim
here is false on both halves at once — wrong provenance and wrong guard — and it is a §9 claim.

**Honest scope, and it is the reason this is `low` rather than `medium`.** The strings *are*
linted — by this task's own test, `NudgeBanner.test.tsx:96-99`, which pushes
`document.body.textContent` through `lint()` after rendering. That is the right instinct and
`SL-20` asked for exactly it. So nothing is unguarded; a docblock is simply wrong about which
mechanism is guarding it, and the mechanism it names would not. The cost is the next reader:
someone extending `BANNED_LEXICON` who greps for what `G3` covers will read this comment and
conclude the nudge surface is handled by CI, and the same session's `U2` and `U3` — which have
no such test — will look handled too. They are not (`SL-28`).

**Invariant violated.** Design v0.8 §9 (the copy linter over every card and nudge string — the
claim, not the coverage); DAG §7 G3 Build.

**Verified by.** `grep -rn "catalog" src/ui/nudge/` → one hit, the comment;
`grep -n "lint\|CATALOG" src/ui/nudge/NudgeBanner.test.tsx` → the DOM lint at `:96-99`, no
catalog import; `tests/guards/copy.test.ts` read — it iterates `CATALOG`, `DRIVER_PHRASES` and
`TemplateNarrator` output and touches no file under `src/ui/**`.

**Fix.** Two words: change the sentence to "no string here mentions quantity, weight or
progress — asserted against the rendered DOM in the test beside this file." Then do what the
sentence originally promised and make it true for the whole lane: one guard under
`tests/guards/` that lints every exported copy constant in `src/ui/**` and `src/cli/**`
individually. That guard is now owed by three separate entries in this log.

---

## Cumulative leaderboard, worst first

Three passes combined: **36 defects across 47 merged tasks.**

`SL-11` is closed — `L3` was attributed retroactively, as its fix asked — so `SL-05` finally
has an owner, and that owner is `claude-session-12uj0q`. It is counted below.

### 1. claude-session-12uj0q — 18 defects (1 high, 9 medium, 8 low): `SL-02`, `SL-03` (shared), `SL-04`, `SL-05`, `SL-10`, `SL-16`, `SL-19`, `SL-20`, `SL-23` (shared), `SL-24`, `SL-27`, `SL-28`, `SL-29`, `SL-31`, `SL-32`, `SL-33` (shared), `SL-35`, `SL-36`

Ranked first on volume: **exactly half the log**, and 60% more than the next session. A case
can be made for swapping this with #2 on severity — `claude-session-014n6NYRN6Rb` owns three of
the log's four `high`s and this session owns one. The case is not strong enough to move it:
eight new defects in one pass across five different tasks is not a bad day, it is a rate.

**The repeated failure across three passes: the guard, the constant, the caller or the wiring
that would make the module true is treated as somebody else's — and the docblock says so, in
writing, incorrectly.**

Pass 1 called this "ships the module and leaves the boundary to somebody else — usually a
somebody named in a comment." Pass 2 called it the same failure "with imports and labels
instead of comments." Pass 3 is the same failure with **whole screens**:

- `SL-27` (high): four screens, four `done`s, zero routes. The stated reason is that
  `routes.tsx` belongs to `U1` — a task this session owns. Then `app.test.tsx:27` was written to
  assert the placeholder is still present, so the correct fix is a red test. `SL-13` was the
  log's other `high` about unreachable work, was fixed three PRs earlier, and this rebuilt it in
  a lane where one agent held every relevant file.
- `SL-36`: "the copy is L1 catalog text, which G3 lints." The file imports no catalog and G3
  reads no DOM. This is `SL-02`'s sentence — "G3 lints engine-produced notes" — with the nouns
  changed.
- `SL-28`: the word `weight` on the diner's confess screen, with X2's nineteen-line docblock
  about that exact collision one directory away, three PRs after `SL-20` said no front-end line
  in this repo is linted. In the *same PR series* this session wrote the DOM-lint test `SL-20`
  asked for — for one of its three screens.
- `SL-29`: the off-limits editor shows a topic saved when the write rejected. The port is
  injected precisely so a test can reject; six tests, none of them do.
- `SL-31`: a new vitest axis added without extending the guard that exists because this repo
  already lost every `scripts/` test to the old one.
- `SL-35`: a guard case whose title asserts the opposite of its body.
- `SL-32`: the `SL-05` fix, one `||` clause short.

**Credit, and it is the largest single body of work in this build.** This session wrote lane U
end to end, `G1`, `G2`, `G3`, `G6`, `K2`, `K3`, `K5`, `L1`, `L2`, `L3`, `M2`, `M3`, `M5`, `N1`,
`X4`, `X5`, `X6` and `P0.7` — and it fixed **five** of this log's defects, four of them somebody
else's. `SL-04`'s fix is the best fix in the log: `parseUsualProfile` and `parseMealLogEntry`
check the actual contract unions rather than `typeof`, return clean objects rather than casts,
use the **same** `Date.parse` predicate `K3`'s `parseDay` uses so the two cannot disagree, and
make sure a newer unparseable record cannot shadow an older valid one — a failure mode the log
did not ask about. `SL-05`'s fix enforces on all four lines and rejects the logged probe. `G6`
is a real guard with a real recorded mutation record. And `C15` below is the third time this
build's trunk was unbroken by a session that was working on something else — this time it was
this one, in `src/config/**`, which it does not own, with the ownership crossing and the
alternative fix both flagged for the integrator. That is the standard.

### 2. claude-session-014n6NYRN6Rb — 11 defects (3 high, 1 medium, 1 shared medium, 6 low): `SL-01`, `SL-03` (shared), `SL-09`, `SL-12`, `SL-18`, `SL-21`, `SL-22`, `SL-25`, `SL-26`, `SL-33` (shared), `SL-34`

**Three of the log's four `high`s, and the two new ones are both in the gate.**

The pattern named in pass 1 — "exhaustive inside the module, incurious at the seam, then
documents the untested assumption as though documenting it made it true" — has scaled up. It is
no longer a seam between two modules; it is the seam between the repo and its own verification:

- `SL-26` (high): a file named `acceptance.test.ts`, whose docblock quotes the DAG's seven-step
  CLI run, importing nothing from `src/cli/**`. Seven steps, seven re-implementations of the
  layer beneath the commands. The PR body argues at length for the harness and never mentions
  the subject. Six lines of probe through the same `fixtureGraph` print two open defects.
- `SL-25` (high): `fs.globSync` — Node 22 — in a repo whose `engines` floor this session wrote
  and whose `src/index.test.ts:91` this session wrote to assert it. CI, also this session's,
  reported it on its very first run, on the PR that installed CI. Five PRs merged through a red
  `code checks`, three of them this session's, each announcing a green suite. Someone else read
  the log.
- `SL-34`: the `SL-22` fix left a byte-identical duplicate of a test fifteen lines from the
  original — the `SL-09` shape, third occurrence, in the commit whose message criticises the
  test it replaced for asserting nothing useful.
- `SL-33` (shared): `P0.6` created a file in `src/config/**`, lane P0, without the integrator.
  That is where `SL-25` entered.

The through-line is sharp and worth stating without decoration: this session writes the best
prose in the repository and the prose is load-bearing in the wrong direction. `SL-01`, `SL-18`,
`SL-22`, `SL-25` and `SL-26` are all cases where a confident written claim — a docblock, a
commit message, a PR body, a test title — stood in for the check that would have falsified it.

For the record on `SL-25`: two of the five merges through the red check are this session's
(#49, #50) and three are `claude-session-12uj0q`'s (#51, #52, #53). The defect is this
session's because the API, the floor it violates, the test asserting the floor and the CI
reporting the violation are all this session's; the three later merges are a separate failure
of nobody reading a red tick, and they belong to everyone who pressed the button.

**Credit, and it remains substantial.** This session wrote both earlier passes of this log —
twenty-four verified defects, most of them other people's — and fixed every one of its own that
was fixable: `SL-01` and `SL-03` better than asked (a closed vocabulary, so a note key without
a phrase is a compile error), `SL-09` bidirectionally, `SL-12` in a three-line docs-only commit
that obeyed the rule it was adding, `SL-13` verified by real `tsx` invocations rather than
inspection, `SL-18` with `Object.hasOwn` and five hostile keys asserted. `X1`'s dispatch is
still the best-reasoned module in the CLI — exit 3 for an internal throw, with the comment
explaining that `gate:cli` reads 1 as "ran correctly, answer was no." `X2` is the one module
that noticed `Read.weight` collides with the banned lexicon and did something about it, which
is why `SL-20` and `SL-28` are other people's defects and not this session's. `P0.6`'s
`fixtureGraph` and `wiring.ts` are the right abstraction and every command now uses them. It
built the gates. It just did not stand in front of them.

### 3. fable-session-0dd9z8 — 9 defects (1 high, 6 medium, 1 low, 1 shared low): `SL-06`, `SL-07`, `SL-08`, `SL-13`, `SL-14`, `SL-15`, `SL-17`, `SL-23` (shared), `SL-30`

The integrator, and the only session with no new merges in this pass — `SL-30` is a `X3` line
from PR #42 that two passes walked past.

**The repeated failure: the integrator role is performed for its own tasks and not for anybody
else's, and the second copy is chosen over the import.**

- `SL-30` (new): `confit ask` prints `[spice tolerance low × 5]` one line under the same driver
  rendered correctly as `your real spice tolerance`. `DRIVER_PHRASES` is complete, exported for
  this, and imported by `AskCard.tsx` forty files away. `replaceAll('_', ' ')` is `SL-01`'s
  failure mode with a cosmetic pass over it, still shipping on the tip.
- `SL-08` (still open, pass 1): the `AskEngine` escalation has now survived **ten** more merges
  and three review passes. Only the integrator can retire it.
- `SL-06` (still open): `kFloor = 5`, second unpinned copy of the privacy floor, in the file
  only the integrator may edit.
- `SL-15` (still open): `usualNote()` in `src/cli/ask.ts` still writes free prose into a
  closed-vocabulary field, so every card `confit ask` prints still has no usual line —
  reproduced again in this pass, at `SL-26`.

**Credit.** The contract freeze has now held **absolutely across three passes** —
`git diff cfd21c5..6c78fa2 -- src/contracts` is empty across 30 tasks and four sessions. That is
the single most valuable property this build has, it is this session's rule, and it has never
once been bent. `M7` remains the best module in the repo. `M4` remains the best-tested adapter.
`P0.3`'s optional-key rule is what makes a keyless CI possible at all.

### 4. L3 — closed

`SL-11` is resolved. `L3`'s registry entry now reads "RESOLVED + ATTRIBUTED. Owner set
retroactively per SL-11", the owner is `claude-session-12uj0q`, and `SL-05` has been moved onto
that session's line above. Every defect in this log now has a name against it.

---

## Caught and closed — the process working

**C9 — `SL-04` is closed, and closed better than the log asked for.** `3114ee9`.
`isUsualProfile` — the predicate that returned `value is UsualProfile` after checking
`typeof x === 'number'` for a `0|1|2|3` — is gone, replaced by `parseUsualProfile` and
`parseMealLogEntry`, which enumerate the contract's actual unions (`spiceTolerance` ∈ 0..3,
`budgetBand` ∈ 1..4, `portionPref` ∈ small|standard|large, `felt` ∈ glad|fine|regret), strip
extra keys, and return a clean object or `null` — never a cast. `newestParsed` replaced
`newest`, so a *newer* record that fails the parser is skipped with a log line and cannot shadow
an older valid one, which the log did not think to ask for. And `parseMealLogEntry` validates
`at` with `Date.parse` + `Number.isNaN` — byte-for-byte the predicate `K3`'s `parseDay` uses at
`src/kernel/rotation.ts:36-42` — so producer and consumer cannot disagree about what a date is.
The `SL-04` probe is now a passing test at `tests/guards/settingsIntegrity.test.ts:223`. Fixed
by **claude-session-12uj0q**. Closed.

**C10 — `SL-05` is closed for the reported case.** Same commit. `violation()` now scans all four
lines, and the log's three-line probe is rejected on the first attempt with
`rotation line names off-corpus "Wagyu Palace"`. Verified by execution against the real
`createLiveNarrator`. Closed with one follow-up in the fix rather than the defect (`SL-32`).

**C11 — `SL-13` (HIGH) is closed.** `219c6fb`. All eleven commands in `COMMANDS` now carry a
handler; `confess` gained the production `confessCommand` built on `liveGraph`. Verified by
running every one of the eleven through `npx tsx src/cli/main.ts` against unreachable services:
none reports `is not implemented yet`. The replacement guard is the inverse of `SL-22`'s
tautology — it collects `spec.handler === undefined` and asserts the list is empty — and it
would have gone red on the original defect. Fixed by **claude-session-014n6NYRN6Rb**, the
session that shipped it and the session that reported it. Closed.

**C12 — `SL-18` is closed.** Same commit. `note in USUAL_PHRASES` → `Object.hasOwn(USUAL_PHRASES, note)`,
with `toString`, `constructor`, `valueOf`, `__proto__` and `hasOwnProperty` all asserted to
yield `undefined`, and the mixed case pinned:
`usualLineFor(['portion_small', 'toString'])` → `'Small plates.'`. Green in the baseline suite.
Fixed by **claude-session-014n6NYRN6Rb**. Closed.

**C13 — `SL-21` is closed, in L1's test file rather than G3's.** Same commit. All ten
`USUAL_PHRASES` values are now iterated through `lint()`, with a docblock naming the defect and
why `weight`/`portion control` are the terms a budget or portion phrase would trip. The log
offered `tests/guards/copy.test.ts` or folding into `CATALOG`; neither was taken, and it does
not matter — the strings are linted in CI, which is the property that was missing. `SL-02` is
therefore **fully** closed at last: the usual-line copy exists, is clean, and is guarded.

**C14 — `SL-11` is closed.** `L3` now has an owner on the lock registry, set retroactively with
the `--owner` flag `fbc88b0` added for the purpose. `SL-05` has been reattributed on the
leaderboard above. The last unattributed defect in this log is gone.

**C15 — the trunk was unbroken a third time, by a third session, in a file it does not own.**
`6c78fa2` (PR #54) replaced `fs.globSync` in `src/config/wiring.test.ts` with a hand-rolled
recursive directory walk, ending the Node-20 breakage of `SL-25`. The diagnosis in that PR is
the best piece of review work in this build: it identified that `globSync` is Node 22, that
`engines` and CI both say 20, that this is therefore green locally for anyone on 22 and red for
everyone the repo claims to support, and that it is the **only** Node-22-only API in the tree
(it swept for others and found `structuredClone`, which is Node 17+). It then verified the
replacement is *equivalent* rather than merely greener — same 18-file set, empty symmetric
difference both ways — and re-verified that the guard still fails when an adapter construction
is planted, in a top-level file **and** in a nested one, so the recursion is exercised rather
than assumed. It deliberately fixed the test rather than raising `engines`/CI to Node 22,
because the support floor is a repo-wide policy call belonging to the integrator, and said so on
the PR with an explicit invitation to revert. `src/config/**` is lane P0; the crossing was
flagged, with the S1/S2 precedent cited. Found and fixed by **claude-session-12uj0q**. PR #54 is
the **first PR in this repository's history whose `code checks` job is green.** Closed.

**Still open.** `SL-05` is closed but `SL-06`, `SL-07`, `SL-08` and `SL-10` remain from pass 1 —
three of the four are the integrator's and two of them can only be fixed by the integrator.
From pass 2: `SL-14` (`URL.pathname` as a file path, both lines), `SL-15` (every `confit ask`
card still has no usual line — re-reproduced in this pass), `SL-16` (the census still calls the
six `UNMATCHABLE_DRIVERS` citable), `SL-17` (`induction-set.json` is still byte-identical to
`reads.json`; `cmp` confirms), `SL-19` (`headline()` at `src/cli/forget.ts:43-46` still prints
`Deleted from Confit` when any single target is `deleted` and the user tier is `skipped`),
`SL-20` (`confit pass neartie` still prints `weight 0.75` and `score(top1)` — re-reproduced by
running the command against the tip), `SL-23` (nothing anywhere persists `NudgeState`; `grep`
across `src/nudge`, `src/memory` and `src/config` finds only the type import). Nine of the
twelve defects from pass 2 are still open, and `SL-26` is the reason none of them has a gate
that would notice.

---

## C16 · SL-26 closed — the acceptance gate now runs the CLI, and five mutations prove it

**Task:** `G8`. **Closed by:** `claude-session-014n6NYRN6Rb` — the session that wrote the defect.

`tests/guards/acceptance.test.ts` now drives every DAG §7 G5 step through `run(argv, …)`: the
real dispatcher, the real argument parser, the real command modules, the real renderer. The
`grep -n "src/cli"` that returned nothing now returns the import on line one.

What was actually missing was not diligence but a **seam**. Six handlers each called
`liveGraph(context.config, context.logger, context.flags)` themselves, which satisfied `P0.6`'s
letter — the graph *was* the single place wiring lived — while making the CLI untestable from
outside: no caller could put fixture stores behind a real command, so the only way to write an
end-to-end test was to stop using the commands. `CommandContext` now carries the graph,
`RunDeps.makeGraph` overrides it, and `wiring.test.ts` fails the build if a handler reaches for
a graph factory again.

**Red-verified against five mutations**, because a gate nobody has tried to defeat is a gate
nobody has tested:

| mutation | caught by |
| --- | --- |
| reinstate `SL-30`'s raw driver token | `enum token spelled with spaces: [spice tolerance low × 8]` |
| reinstate `SL-15`'s sentence-as-a-key | the §5 four-line assertion |
| unwire a command back to the placeholder (`SL-13`'s shape) | the `COMMANDS` walk |
| make the sweeper delete again (`D-7`) | `expected 220 to be 221` |
| a handler reaching for `liveGraph` | `wiring.test.ts` names the file |

The fourth is worth naming because it **initially did not fail**. `fixtureGraph` pins its clock
to the demo's evening, which is *ahead* of any real test clock, so `sweepOnce(new Date())`
computed a negative age for all 221 entries, skipped every one as "still settling", and reported
zeroes. The sweep step passed while examining nothing. That is the same failure as `SL-26` itself
one level down — a step that looks like coverage and is not — and it was found by attacking the
new gate rather than by reading it.

### Closed on the way, because running the CLI is what found them

**`SL-15` (pass 2, HIGH) — closed.** Root cause: two vocabularies for one field.
`usualLineFor` filters against `USUAL_PHRASES`, a closed **key** set, because an unfiltered
pass-through is how `SL-01` put a raw identifier on a card and how `SL-18` threw on
`'toString'`. `src/cli/ask.ts` handed it a full English **sentence**, which is not a key, so
`Object.hasOwn` dropped it and `copy.usualLine` came back `undefined` on **every** card
`confit ask` ever printed. One of the four lines design v0.8 §5 specifies, absent, with no error
anywhere. `usualNote` now returns `['solo_comfortable']` and the wording lives in the catalog
where `G3` lints it. Cards now end `Fine to eat alone.`

**`SL-30` (pass 3, MEDIUM) — closed, and it was being *held in place* by a test.**
`src/cli/ask.test.ts:54` asserted `result.lines.some((l) => l.includes('solo comfort × 6'))`.
That is `K5`'s banned lexicon, required by a test. A test demanding the defective form is worse
than no test: it converts a fix into a regression. The chip now renders `DRIVER_PHRASES`, the
way `U3`'s `AskCard` already did, and the test asserts no line matches `/solo comfort|solo_comfort/`.

### Two new defects, found in the first ten seconds of running the built binary

Both were invisible to 765 passing tests, because the suite runs TypeScript sources and nothing
had ever executed `dist/`.

**`SL-37` · HIGH · `npm run build` produced a `dist/` that could not boot at all.**
`tsc` copies no assets, and `src/contracts/fixtures/index.ts` reads `./pool-baseline.json`
beside its own module *at import time*. So `node dist/src/cli/main.js --help` died with
`ENOENT … dist/src/contracts/fixtures/pool-baseline.json` before dispatching a single command —
every command, every invocation, from the first build. `npm run build` exited 0 throughout,
because compiling and running are different questions and only one was being asked. Fixed with
`scripts/copy-assets.mjs`; the gate now boots the artifact, which is what surfaced it.
**Author:** `claude-session-014n6NYRN6Rb` (`P0.1`, the toolchain).

**`SL-38` · LOW · `confit --help | head -2` crashed with an unhandled `EPIPE` and exit 1.**
A closed pipe is an ordinary shell idiom; Node reports it as an asynchronous `'error'` event on
the stream, so it is not catchable around `write`. Exit 1 is also the wrong code — `gate:cli`
reads 1 as "ran correctly, answer was no", so a broken pipe would have *passed* a gate. Handlers
installed at the entrypoint only, so `run()` still never touches process streams.
**Author:** `claude-session-014n6NYRN6Rb` (`X1`).

### What this does not fix

Seven of pass 2's defects are still open, and they are now *gateable* rather than gated:
`SL-14`, `SL-16`, `SL-17`, `SL-19`, `SL-20`, `SL-23`, plus pass 1's `SL-06`/`SL-07`/`SL-08`/`SL-10`.
`SL-19` and `SL-20` in particular are single-command defects that the new harness can assert in
three lines each. There is no longer an excuse of "nothing runs the CLI".

---

# Fourth pass

**Reviewed PR #65 — `M20`, one commit `24600d4` on `claude/upload-code-artifact-zop9uz` · 25 July 2026**

## What was reviewed

One PR, one task, one commit: **28 files, 725 insertions, 121 deletions.** New:
`src/memory/proseBuffer.ts` (+159), its test (+121), `src/contracts/stubs/proseBuffer.ts`.
Rewritten: `src/memory/user.ts`, `src/memory/writeRead.ts`, `src/cli/confess.ts`,
`src/cli/sweep.ts`, `tests/guards/offLimits.test.ts`, plus the `ProseWrite` contract and
`AppConfig.proseBufferPath`. Author of every line: `claude-session-014n6NYRN6Rb`, the
registry's owner of `M20`.

Baseline on the head commit, checked before anything else:

| gate | result |
| --- | --- |
| `npm run typecheck` | **exit 0** |
| `npm run lint` | **exit 0** |
| `npm test` | **exit 0 — 908 tests, 58 files** |

**10 new defects: 4 high, 4 medium, 2 low.** Everything below was executed, not read: six
`confit confess` processes released against one buffer file through a barrier, the real
`confess()` driven against the real `createUserStore` and a real file-backed buffer with a
failing `ingestBatch`, and three source mutations run against the full 908-test suite and
reverted. Four findings are red-verified by mutation and say so.

**The shape of this pass.** `M20`'s premise is sound and its central measurement is real:
XTrace makes one episode per ingest *call*, so batching is the only thing that produces a
synthesis across confessions, and the docblocks explaining it are the best in the repo. Then
the implementation put a shared mutable queue behind an unsynchronised read-modify-write in a
command that runs once per process, and wrote 121 lines of test that never runs two of them.
The result is that `D-10`'s sanctioned loss — *the buffer file may be lost* — has been quietly
widened into two failures nobody ruled on: **an ordinary burst of confessions destroys most of
them** (`SL-39`), and **an ordinary flush ingests the same confession twice** (`SL-40`). The
second one defeats the task's own purpose, because a synthesis over four rows where three are
the same confession is exactly the per-confession paraphrase `M20` exists to stop.

The other half of the pass is the receipt. `D-10`'s write-up names **one** consequence the
owner should see rather than discover — "a buffered confession has not reached XTrace when
`confess` prints its receipt … the receipt must say which of the two it is." The CLI receipt
was fixed, carefully and well. The other front end still prints `your memory: written`
(`SL-42`), and the repo's own new guard assertion documents the lie two lines apart.

## Table

| id | file:line | task | author | sev | one line |
| --- | --- | --- | --- | --- | --- |
| SL-39 | `src/memory/proseBuffer.ts:119-137` | M20 | claude-session-014n6NYRN6Rb | high | Six concurrent `confess` processes, released together: **three to five of six confessions destroyed.** Every one printed `held … or on the next sweep`. |
| SL-40 | `src/memory/proseBuffer.ts:120-136` | M20 | claude-session-014n6NYRN6Rb | high | The same missing lock POSTs the same three confessions **twice**, both under `conv_id confit:prose:A:0`. `D-10` sanctioned loss, not duplication, and duplication is what breaks the synthesis. |
| SL-41 | `src/memory/user.ts:163-177`, `src/cli/confess.ts:106-119` | M20 | claude-session-014n6NYRN6Rb | high | One `503` destroys four confessions. The receipt says `FAILED (your words were not recorded)` — singular — and no line, stdout or stderr, ever says four. |
| SL-42 | `src/ui/confess/ConfessScreen.tsx:139` | M20 | claude-session-014n6NYRN6Rb | high | `your memory: written` for a confession that is on the local disk. `D-10`'s single named consequence, fixed in the CLI and left standing in the UI. |
| SL-43 | `src/cli/sweep.ts:113-121`, `:147-156` | M20 | claude-session-014n6NYRN6Rb | medium | `pass sweep --watch` never flushes the buffer. Red-verified: making `pass sweep` not flush **at all** leaves 908/908 green. |
| SL-44 | `src/memory/proseBuffer.test.ts:115-120` | M20 | claude-session-014n6NYRN6Rb | medium | A test titled "batches four at a time" asserts `BATCH_SIZE > 1`. Red-verified: `3` and `20` pass all 908 tests — including the value the docblock names as broken. |
| SL-45 | `src/config/env.ts:40`, `:30`, `.gitignore` | M20 | claude-session-014n6NYRN6Rb | medium | Raw confessions default to `.confit/prose-buffer.json` **relative to the shell's cwd**, inside an un-ignored path in the git tree, and the promised "logged on first write" logs nothing. |
| SL-46 | `src/memory/proseBuffer.ts:86-96` | M20 | claude-session-014n6NYRN6Rb | medium | `as BufferFile` over a file on disk. A JSON-valid, shape-invalid buffer throws from `pending`, `append` **and** `drain`, and never reaches the write that would repair it — the personal tier is off permanently. |
| SL-47 | `src/memory/proseBuffer.ts:110-116`, `:72` | M20 | claude-session-014n6NYRN6Rb | low | "Distinct per flush, so each batch is its own conversation" — the counter it is built from resets to `0` on exactly the buffer loss `D-10` sanctions. |
| SL-48 | `docs/confit-v0.8-task-dag.md:219-231` in `24600d4`; `src/memory/user.ts:9-12`; `src/memory/writeRead.ts:16` | M20 | claude-session-014n6NYRN6Rb | low | `D-10`'s thirteen lines of ruling landed buried in a 28-file implementation commit — §2's rule, whose own paragraph cites `SL-12`. Two docblocks still describe the verify-and-retry this PR deleted. |

---

## SL-39 · HIGH · claude-session-014n6NYRN6Rb put a shared queue behind an unsynchronised read-modify-write in a command that runs once per process, and destroyed four confessions in six

**Task:** `M20`. **Files:** `src/memory/proseBuffer.ts:119-137` (`append`), `:86-96` (`read`),
`:98-104` (`write`).

**What the code does.** `append` is read-then-mutate-then-write over one JSON file, with
nothing between the read and the write:

```ts
const profiles = read();                      // readFileSync
const state = stateFor(profiles, profile);
state.texts.push(text);
if (state.texts.length < BATCH_SIZE) {
  profiles[profile] = state;
  write(profiles);                            // writeFileSync — last writer wins
  return null;
}
```

No lock, no `O_EXCL`, no compare-and-swap, no append-only log. The module's own docblock states
the premise that makes this fatal: "**A confession arrives in its own CLI process**, so
batching at write time is impossible without holding text across processes. Hence a file."
Every `confit confess` is a separate OS process performing this sequence on the same path. Two
that overlap both read the same array and both write their own copy of it; the second write
erases the first confession outright.

**Reproduction, executed.** Six `confess`-equivalent processes, each loading the real
`createProseBuffer` and then spinning on a barrier file so the JIT and module load are paid
*before* any of them touches the buffer, released simultaneously by the parent. Four runs:

| run | confessions appended | in the buffer afterwards | flushed | **destroyed** |
| --- | --- | --- | --- | --- |
| 1 | 6 | `["c4","c2"]` | 0 | **4** |
| 2 | 6 | `["c6"]` | 0 | **5** |
| 3 | 6 | `["c3","c5"]` | 0 | **4** |
| 4 | 6 | `["c4","c1","c6"]` | 0 | **3** |

`batches` stayed `0` in every run, so not one of the six ever reached a flush either. And
every one of those six invocations exited `0` and printed, from `confess.ts:112`:

```
  your memory    held   (with N of yours — sent together, or on the next sweep)
```

Six confessions accepted, six receipts promising a later send, one to three confessions
actually retained.

**Why it is a defect and not `D-10`.** `D-10` is quotable, and it is narrow: "**losing the
buffer** is explicitly acceptable", and `proseBuffer.ts:19-24` restates it as "**if the file is
lost**, some confessions never reach XTrace." That ruling covers a *file-scoped* event — a
wiped disk, a corrupt buffer, an `rm`. What is above is not that. Nothing failed: no crash, no
I/O error, no substrate outage, no corrupt file. The buffer file is intact, well-formed, and
*wrong*. This is per-write loss on the ordinary success path, at a rate of 50-80% under
concurrency, and it is invisible — the loser's receipt is identical to the winner's. An owner
who signed off on "we may lose the buffer" was not shown "we lose most of a burst, silently,
and tell each user their words are held." `D-10`'s own framing is that the owner "should see
rather than discover"; this is the discover column.

**Reachability, honestly.** A human typing one `confess` at a time will not hit this. Two
things will: a scripted or seeded demo (`confit confess … & confit confess … &` is how every
other burst in this repo has been produced, including `M20`'s own live measurement of seven
confessions), and the UI, which shares `writeRead` and does not serialise submissions. It also
needs no true parallelism to bite — any interleaving of two processes' read and write windows
does it, and the window here spans a `readFileSync`, an object walk and a `writeFileSync`.

**Invariant violated.** DAG §4 `D-10` (loss is sanctioned at the granularity of the buffer, not
the write); design v0.8 `[E27]`/`[E11]` by consequence, since the consent copy and the receipt
both promise the text goes to the user's own memory.

**Verified by.** The barrier-synchronised six-process run above, four times, against unmodified
`src/memory/proseBuffer.ts` at `24600d4`. Working tree clean afterwards.

**Fix.** The cheap and correct one, and it is genuinely cheap: stop sharing one mutable
document. Write each confession as its own file — `<dir>/<profile>/<uuid>.txt`, created with
`{ flag: 'wx' }` — and make `append`/`drain` a `readdirSync` plus `unlinkSync` per file taken.
Creation is then atomic per confession, two processes cannot collide because they never write
the same path, and a flush claims files by renaming them into a batch directory before sending.
That is *less* machinery than the current file, not more: no counter to keep, no document to
merge, and it deletes `SL-40`, `SL-46` and `SL-47` at the same time. If a shared document must
stay, then `append` needs a real lock — an `O_EXCL` lockfile with a stale-age override — and
`D-10` needs re-asking, because a lock is the thing the decision was read as ruling out.

---

## SL-40 · HIGH · the same missing lock POSTs one confession twice under one `conv_id`, which is the failure M20 was built to remove

**Task:** `M20`. **Files:** `src/memory/proseBuffer.ts:120-136`; `src/memory/user.ts:172`.

**What the code does.** `append` clears the profile's texts and increments `batches` *before*
returning the flush, and both halves land in the same unsynchronised read-modify-write as
`SL-39`. So two processes that overlap while a profile sits at `BATCH_SIZE - 1` each compute a
full batch from the same three retained texts, each returns a `Flush` containing them, and
each caller then does its own `client.ingestBatch(...)` at `user.ts:172`.

**Reproduction, executed.** Three confessions already waiting (`old1`,`old2`,`old3`, written one
at a time, normally), then two `confess` processes released together on the barrier. Runs 1 and
3 of three:

```
{"me":"new2","flushed":["old1","old2","old3","new2"],"convId":"confit:prose:A:0"}
{"me":"new1","flushed":["old1","old2","old3","new1"],"convId":"confit:prose:A:0"}
--- final --- {"profiles":{"A":{"texts":[],"batches":1}}}
```

Two POSTs. `old1`, `old2` and `old3` are in both. Both carry the **identical** `conv_id`. And
`batches` advanced by one, not two, so the *next* flush will reuse an id again.

**Why it is worse than the loss.** `D-10` ruled on loss and said nothing about duplication,
because duplication was not on the table. It matters here more than loss does, because of what
the batch is *for*. `M20`'s entire justification — measured, quoted in three docblocks — is
that XTrace synthesises across the messages inside one call. Hand it four messages of which
three are the same confession and the synthesis it produces is a paraphrase of that one
confession, weighted three to one. That is, precisely and by name, the defect the task exists
to fix: "8 confessions gave 8 episodes across 8 conv_ids, every episode a paraphrase of a
single confession." `M20` then spends 159 lines arriving back at a per-confession paraphrase by
a different route. Downstream, `personalClaim` (`user.ts:201`) reads `episodes[0].content` onto
an Ask card, so the duplicated confession is what the user is told about themselves.

The shared `conv_id` compounds it: the module's own test comment (`proseBuffer.test.ts:64-67`)
names the harm — "a shared id would just make two batches indistinguishable in the substrate" —
and here two genuinely different batches are indistinguishable, so an operator cannot even
diagnose the duplication after the fact.

**Invariant violated.** DAG §4 `D-10` ("batching is not optional" — a batch of near-duplicates
is not the batch that was ruled on); `M20`'s stated acceptance ("4 confessions produced 1
conv_id and 1 episode synthesising all four", per the task's own registry note).

**Verified by.** The two-process barrier run above, three times; duplication in 2 of 3, and the
shared `conv_id` in all runs that flushed.

**Fix.** `SL-39`'s fix removes this as a side effect: if a flush *claims* its confessions by
renaming per-confession files into a batch directory, two claimants cannot claim the same file
and the loser's batch is empty. Whatever the mechanism, the `conv_id` must be minted from
something unique to the flush — a `randomUUID()` — not from a counter in the document the race
is already corrupting (`SL-47`).

---

## SL-41 · HIGH · one `503` destroys four confessions, and the receipt reports one

**Task:** `M20`. **Files:** `src/memory/user.ts:163-177` (`writeProse`);
`src/memory/writeRead.ts:114-124`; `src/cli/confess.ts:106-119` (`targetLines`).

**What the code does.** `append` clears the buffer *before* the caller ingests — deliberately,
and `D-10` does sanction that — and then `writeProse` calls `ingestBatch` with **no `try`**. So
a failed flush POST propagates to `writeRead`, which catches it into one warning and
`wrote.prose = false`, and `confess` renders `targetLines` with `wrote.prose === false`.

**Reproduction, executed.** Real `confess()`, real `createUserStore`, real file-backed
`createProseBuffer`, real `StubRelay`/`StubPoolStore`, and an `ingestBatch` that rejects with
`XTrace 503`. Four confessions:

```
--- confession 1 ---   your memory    held   (with 1 of yours — sent together, or on the next sweep)
--- confession 2 ---   your memory    held   (with 2 of yours — sent together, or on the next sweep)
--- confession 3 ---   your memory    held   (with 3 of yours — sent together, or on the next sweep)
--- confession 4 ---   your memory    FAILED (your words were not recorded)
                       ! prose write failed — personal memory not recorded: XTrace 503
--- logger lines ---
user: confession held for A — 1/4 until the batch is sent
user: confession held for A — 2/4 until the batch is sent
user: confession held for A — 3/4 until the batch is sent
writeRead: prose write failed for 0a1f6ea6-…: XTrace 503
```

Buffer afterwards: empty. Four confessions gone; the words "four", "batch" and "lost" appear
nowhere, on either stream.

**Why it is a defect.** Not the loss — `D-10` bought that. The **accounting**. Three receipts
made a specific forward promise ("sent together, or on the next sweep") and the fourth reports
a singular failure of the fourth confession only, in the second person: *your words* were not
recorded. A user reading these four receipts in order concludes that confessions 1-3 are still
queued and one is gone, and re-confesses one thing. Three are gone and nothing will retry.
This is the identical defect the same session's `forget` shipped and the log already
records — a per-target line that overstates what happened — restated in the PR whose own
docblock cites it: `confess.ts:104`, "a receipt that overstates what happened is the same defect
as `forget` printing 'Deleted from Confit' over two skipped targets."

It is also a §1 breach on the degrade path: "**A degrade path is a handled error and must log
which flag it flipped.**" The flag flipped here is four confessions destroyed, and the log line
carries a `read_id` and an HTTP message. `flushProse` twenty lines below gets this exactly
right — `"${n} confession(s) lost, which D-10 accepts"` — so the correct line already exists in
the file and was not reused on the path that actually loses them.

**Reachability.** Every fourth confession, whenever XTrace is unavailable, rate-limiting, or
slow enough to reject. `pool: 'relay-only'` is a declared flag in this product precisely
because XTrace being unavailable is expected.

**Verified by.** The four-confession run above against unmodified sources at `24600d4`; plus
`grep -n "try\|catch" src/memory/user.ts` — `writeProse` has neither.

**Fix.** Two lines of copy and one `catch`. Wrap the `ingestBatch` in `writeProse`, log
`"${flush.texts.length} confession(s) lost"` the way `flushProse` already does, and return the
count so `targetLines` can print `FAILED (4 confessions, including this one, were not
recorded — they are gone, not queued)`. The `WroteFlags`/`ProseWrite` pair already has room for
it: `ProseWrite.jobId` is dead weight today (its only consumer in the whole repo is
`user.test.ts:106` asserting it is truthy), so replace it with the lost count.

---

## SL-42 · HIGH · the UI still tells the user their confession reached their memory, which is the one consequence D-10 wrote down

**Task:** `M20`. **File:** `src/ui/confess/ConfessScreen.tsx:139`. Corroborating:
`tests/guards/offLimits.test.ts:177` and `:183`.

**What the code does.** The confess screen's done-state renders the write report from three
booleans:

```tsx
<li>your memory: {wrote?.prose === true ? 'written' : 'not written'}</li>
```

`wrote.prose` is set `true` by `writeRead.ts:120` on **every** successful `writeProse`,
including the 3-in-4 that only put the text in a local file. So the UI prints
`your memory: written` for a confession sitting in `.confit/prose-buffer.json`, under a heading
that reads **Added to the pot**.

**Why it is a defect.** `D-10` names exactly one consequence for the owner: "a buffered
confession has **not** reached XTrace when `confess` prints its receipt, so
`your memory ok (your words, your tier only)` becomes untrue at the moment it is printed.
Deferral is not loss, but the receipt must say which of the two it is. **Fixed with the copy,
not with more machinery.**" The copy fix was applied to one of the two front ends. DAG §0.1 is
explicit that the CLI and the UI are two front ends over one core, and this PR added
`proseBuffered` to `WriteReadReport` — the exact field the UI needs — then did not read it.
`ConfessScreen` receives the whole report; the fix is one ternary.

The report is worse than the CLI's old line, too: `written` is flatter and more absolute than
`ok (your words, your tier only)`, and it sits beside `pot: written` and `relay: written`,
which are true, so nothing signals that one of the three means something different.

**And the PR's own new guard assertion documents it.** `tests/guards/offLimits.test.ts`, edited
in this PR, now contains six lines apart:

```ts
expect(result.wrote).toEqual({ relay: true, pool: true, job: true, prose: true });   // :177
…
expect(h.buffered('A')).toBe(1);                                                     // :183
expect(h.countRows('A') - userRowsBefore).toBe(0);                                   // :184
```

`prose: true`, buffered `1`, XTrace rows `0` — the author wrote down that `prose: true` means
"not in XTrace" and left the UI reading `prose: true` as "written". The comment above `:181`
even explains the distinction.

**Reachability.** Every confession through the UI, three times in four. The screens are wired
(`SL-27` closed), so this is the shipping path.

**Invariant violated.** DAG §4 `D-10` (the receipt must distinguish held from sent); design
v0.8 `[E27]`; DAG §0.1 (no behaviour — including the honesty of a receipt — in one front end
only).

**Verified by.** `src/ui/confess/ConfessScreen.tsx:126-146` read in full; `writeRead.ts:117-124`
traced; `grep -rn "proseBuffered" src/ui` → **nothing**.

**Fix.** `ConfessScreen` already has `phase.outcome`. Read `proseBuffered` off it and print
`held on this device — sent with the next few, or on the next sweep` when it is non-zero. Then
put the assertion in `ConfessScreen.test.tsx` — the file this PR already edited — so the two
front ends cannot drift on this again.

---

## SL-43 · MEDIUM · `pass sweep --watch` never drains the buffer, and no test in the repo notices that `pass sweep` drains it at all

**Task:** `M20`. **File:** `src/cli/sweep.ts:113-121` and `:147-156`.

**What the code does.** The flush is inside the `--once` branch only:

```ts
if (!context.argv.flags.has('watch')) {
  const prose = await flushProse(deps, context);      // :115
  …
}
// --watch: sweep, log, sleep, repeat — and never flush            :147-156
while (!interrupted) {
  last = await deps.sweep(now());
  …
}
```

**Why it is a defect.** The buffer has exactly two flush triggers, and `proseBuffer.ts:47-50`
says so in the paragraph justifying `BATCH_SIZE = 4`: "the threshold is only one of two
triggers and the other (`pass sweep`) is operator-driven." `sweep.ts:38-42` repeats it: the
flush is here "because the buffer's size threshold alone would leave a profile's last few
confessions unsent indefinitely." `--watch` is the mode an operator *leaves running* — it is
the one described in the module docblock as "the command that must work when the author's
session is gone" — and it is the mode that never fires the second trigger. So the deployment
posture that looks most like continuous drainage is the one where a profile's last one to three
confessions sit on local disk forever. `indefinitely` is the author's own word for the failure,
in the docstring of the function that has the gap.

**Red-verified, and this is the part that should sting.** I replaced line 115 with
`const prose = 0;` — `pass sweep` no longer drains the confession buffer under **any** flag —
and ran the whole suite:

```
Test Files  58 passed (58)
     Tests  908 passed (908)
```

Green. `grep -n "flushProse\|confessions" src/cli/sweep.test.ts` returns **nothing**: the new
dep, the new report line, the new `confessions_sent` JSON field and the error-swallowing
wrapper have no test of any kind, and `tests/guards/acceptance.test.ts` — the gate `C16` built
specifically so the CLI is exercised end to end — does not reach them either. §1: "Every task
ships tests in the same PR. A task is not done because the code exists." Mutation reverted;
tree clean.

**Invariant violated.** DAG §1 (tests in the same PR); `M20`'s own stated design (two triggers).

**Verified by.** The mutation above; `grep` over `src/cli/sweep.test.ts`; the `--watch` loop read
in full.

**Fix.** Move the flush to the top of the returned handler, before the branch, and add the one
line to the watch loop body so a long-running watch drains on every pass. Then two tests in
`sweep.test.ts`: `--once` calls `flushProse` and prints the count, and `--watch` calls it once
per pass. Both are three lines with the existing `context()` helper.

---

## SL-44 · MEDIUM · a test titled "batches four at a time — not one, which is the defect it exists for" asserts that four is greater than one

**Task:** `M20`. **File:** `src/memory/proseBuffer.test.ts:115-120`.

**What the code does.**

```ts
it('batches four at a time — not one, which is the defect it exists for', () => {
  // Pinned deliberately. … If this constant drifts back to 1 the whole task is undone with
  // nothing else going red.
  expect(BATCH_SIZE).toBeGreaterThan(1);
});
```

**Red-verified by mutation, twice.** `BATCH_SIZE = 3` → **908/908 pass.** `BATCH_SIZE = 20` →
**908/908 pass.** Both reverted; tree clean. So the constant is pinned against `1` and — by
three unrelated tests that happen to append exactly two texts and expect no flush — against
`2`. Every other value in the universe is green, including the two the module's own docblock
argues are wrong: `proseBuffer.ts:47-50` says "Four, not one and not **twenty**. … Twenty means
a demo never reaches a flush." The suite is content with twenty. A test whose name asserts a
number and whose body asserts a strict inequality is not a pin; it is a comment with a passing
assertion attached, and its own comment claims otherwise ("Pinned deliberately").

`expect(BATCH_SIZE).toBe(4)` is the whole fix, and it is four characters different from what
was written.

**The rest of the file has the same texture, which is why this is `medium` and not `low`.**

- `:78-84` — `it('clears before the caller ingests, so a failed send loses the batch')` performs
  **no send**. Its only assertion is `expect(buf.pending('A')).toBe(0)`, which is byte-identical
  in meaning to `:22` in the first test six lines up. The named behaviour — that a failed send
  loses the batch — is untested here and untested anywhere: `user.test.ts` covers a failing
  `flushProse` but nothing covers a failing flush inside `writeProse`, which is the path
  `SL-41` proves destroys four confessions and misreports it. `SL-09`/`SL-34`'s duplicate-body
  shape, fourth occurrence.
- `:23` — `await Promise.resolve()` as the last statement of an `async` test that contains
  nothing asynchronous. Lint appeasement left in the suite.
- `:32` — `expect(buf.append('A', 'a2')?.texts).toBeUndefined(); // still under the threshold`
  inside a test named `keeps profiles apart`. It does go red at `BATCH_SIZE = 2`, so it is not
  vacuous, but `?.texts` reached through optional chaining is an oblique way to write
  `toBeNull()`, and the assertion has nothing to do with keeping profiles apart — the two
  `pending` assertions above it are the ones that earn the title.

**Invariant violated.** DAG §1 (a task is done when its stated acceptance check passes — the
acceptance recorded in the registry for `M20` is "4 confessions produced 1 conv_id and 1
episode", and no test asserts the 4).

**Verified by.** Two full-suite mutation runs (`BATCH_SIZE = 3`, `= 20`), both green, both
reverted; and one at `= 2`, which fails three tests, none of them this one.

**Fix.** `toBe(4)`. Then either give `:78-84` a send to fail — inject a rejecting `ingestBatch`
and assert the count in the log line — or delete it and stop describing untested behaviour in
an `it` string.

---

## SL-45 · MEDIUM · the most sensitive text in the product defaults to a path that follows the shell's working directory and is not in `.gitignore`

**Task:** `M20`. **Files:** `src/config/env.ts:40`, `:30`, `:89`; `.gitignore`.

**What the code does.**

```ts
const DEFAULT_PROSE_BUFFER_PATH = '.confit/prose-buffer.json';
```

Relative. `mkdirSync(dirname(path))` and `writeFileSync(path)` in `proseBuffer.ts:99-103`
resolve it against `process.cwd()` of whichever process is running.

**Three consequences, all checked.**

1. **The buffer follows the shell.** `confit confess` from `~` and `confit confess` from the
   repo write two different buffers, so neither ever reaches `BATCH_SIZE` and the batching this
   task exists for silently does not happen. Worse, `pass sweep` — the only other flush trigger
   (`SL-43`) — drains the buffer belonging to *its own* cwd, so an operator sweeping from
   anywhere else drains an empty file, reports `confessions sent: 0`, and the confessions stay
   on disk indefinitely with no indication they exist. The env var `CONFIT_PROSE_BUFFER` is
   offered as the escape, but the failure is silent, so nobody learns they need it.
2. **It lands in the git working tree, un-ignored.** `git check-ignore -v .confit/prose-buffer.json`
   → **exit 1, no match.** `.gitignore` covers `node_modules/`, `dist/`, `coverage/`,
   `*.tsbuildinfo`, `.env*`, `*.log`, `.DS_Store` — not `.confit/`. Running the demo from the
   repo, which is how every gate and every acceptance run in this project has been driven, puts
   raw confession prose in an untracked file inside the checkout, where `git add -A` commits it
   and `git status` advertises it. This is the file whose own docblock calls it "the most
   sensitive text in the product" and reasons carefully about not putting it on the relay
   because one token reads everything. It then put it next to `package.json`.
3. **The stated mitigation does not exist.** `env.ts:30`: "Overridable with `CONFIT_PROSE_BUFFER`
   so an operator can put it somewhere they control — **the path is logged on first write**."
   Nothing logs the path. `createProseBuffer` takes no logger, imports no logger, and calls
   nothing that could log: `grep -n "logger" src/memory/proseBuffer.ts` → no match. So the one
   affordance that would let an operator discover which of their several `.confit` directories
   holds their confessions is a sentence in a comment. `SL-02`/`SL-36`'s named-mechanism
   pattern, now applied to a privacy affordance.

**Why `medium`.** `.gitignore` and `src/config/**` are lane P0 and this session is the
integrator, so there is no ownership excuse and the fix is one line in each. Nothing has leaked
in this repo yet — `git log --all --diff-filter=A -- '.confit'` is empty — which is the only
reason this is not `high`.

**Invariant violated.** Design v0.8 `[E9]`-successor split (the local tier is local *and*
locatable); DAG §1 ("a degrade path … must log which flag it flipped" — the flag here is *where
your confessions are*).

**Verified by.** `git check-ignore -v .confit/prose-buffer.json` → exit 1;
`grep -n "logger\|console" src/memory/proseBuffer.ts` → no match; `env.ts:30` read verbatim.

**Fix.** Default to `${os.homedir()}/.confit/prose-buffer.json` — the buffer is per-machine by
`D-10`'s own argument, so per-machine is where it belongs, and a home-relative path removes the
cwd-dependence and the git-tree question together. Add `.confit/` to `.gitignore` anyway. Then
either log the resolved path once from `wiring.ts` where a logger is in hand, or delete the
sentence that says it is logged.

---

## SL-46 · MEDIUM · `as BufferFile` over a file on disk, and the shape it does not check disables the personal tier permanently

**Task:** `M20`. **File:** `src/memory/proseBuffer.ts:86-96`.

**What the code does.**

```ts
const parsed = JSON.parse(readFileSync(options.path, 'utf8')) as BufferFile;
return parsed.profiles ?? {};
```

A cast. No validation of `profiles`, of any `BufferState`, of `texts` being an array or
`batches` a number. The `catch` below it — with the comment "Missing, unreadable or **corrupt**
all mean the same thing here: nothing is buffered" — only ever fires for `JSON.parse` and
`readFileSync`. A file that is valid JSON and the wrong shape sails through the cast and blows
up downstream.

**Executed against the real module.** Four bodies, three entry points each:

| buffer file contents | `pending` | `append` | `drain` |
| --- | --- | --- | --- |
| `{"profiles":{"A":{}}}` | **throws** `…undefined (reading 'length')` | **throws** `…undefined (reading 'push')` | **throws** |
| `{"profiles":{"A":{"texts":null,"batches":0}}}` | **throws** `…null (reading 'length')` | **throws** | **throws** |
| `{"profiles":[]}` | ok | ok | ok |
| `null` | ok | ok | ok |

**Why it matters more than "a corrupt file".** The throw happens *before* `write()`, so the bad
file is never replaced. `writeRead.ts:121` catches it into `prose write failed — personal
memory not recorded` and `confess` carries on with exit 0. The result is a `confit` install
where **every future confession's prose is silently discarded, forever**, one warning line at a
time, and the only symptom is a per-target `FAILED` that looks like an XTrace outage. There is
no self-heal, no `confit pass` command that resets the buffer, and the log never names the
file. The `drain` column means `pass sweep` cannot clear it either.

The docblock claims this case is handled and the suite claims to test it:
`:86 'a corrupt file reads as empty rather than failing confess'` writes `'not json at all'` —
the one corruption class that *is* handled — and asserts the recovery. The class that is not
handled is untested and the comment says it is covered.

**And it is §1, in the file that should know better.** "TypeScript strict, no `any`. **Parse
external input at the boundary** and hand typed values inward." A JSON file on disk, editable
by the operator the env var invites to relocate it, is external input. `SL-04` is in this log
for precisely this — a predicate that checked shapes loosely and "launder[ed] `spiceTolerance:
42` into the type system" — and the fix for `SL-04` is `parseUsualProfile` and
`parseMealLogEntry`, forty careful lines in `src/memory/user.ts:97-149`, in the same lane, in
the same PR's diff, imported by the same module that consumes this buffer. One file over, the
same author wrote a bare cast.

**Reachability, honestly.** A torn `writeFileSync` usually yields invalid JSON, which is caught.
The realistic routes are an operator hand-editing or truncating the file the docblock invites
them to relocate, and any future writer of the format. Low frequency, unbounded blast radius,
and the code claims the case is handled — which is what puts it at `medium`.

**Verified by.** The table above, produced by `npx tsx` against unmodified
`src/memory/proseBuffer.ts` at `24600d4`; `proseBuffer.test.ts:86-96` read.

**Fix.** Twelve lines, in the style already established next door: a `parseBufferState` that
returns a clean `{texts: string[], batches: number}` or `null`, applied per profile, dropping
what fails and logging that it did. Every skipped entry is a loss `D-10` genuinely does cover;
crashing every future write is not.

---

## SL-47 · LOW · "Distinct per flush" is built from a counter that resets on exactly the loss D-10 sanctions

**Task:** `M20`. **Files:** `src/memory/proseBuffer.ts:110-116`, `:72`.

**What the code does.** `Flush.convId` is documented at `:72` as "**Distinct per flush**, so each
batch is its own conversation and gets its own episode", and built at `:114` as
`` `confit:prose:${profile}:${String(state.batches)}` `` — a counter stored inside the buffer
file.

**Why it is wrong.** The counter dies with the file, and the file is the thing `D-10` says may
be lost. Lose or corrupt the buffer — the sanctioned event, the one `read()`'s `catch` exists
for — and `batches` restarts at `0`, so the next flush is `confit:prose:A:0` again, colliding
with a conversation already in XTrace. The two failure modes the design accepts as free are
therefore not free: they cost `conv_id` uniqueness, which is the one property the id was
introduced to have. The race in `SL-40` produces the collision without any loss at all — two
different batches, both `confit:prose:A:0`, observed.

**Scope, and why it is `low`.** The measured behaviour the whole task rests on is that a shared
`conv_id` across separate POSTs does **not** merge episodes, so a collision does not corrupt the
substrate's content. The cost is diagnostic, and the file itself names it:
`proseBuffer.test.ts:64-67` — "a shared id would just make two batches indistinguishable in the
substrate." That is precisely the state produced. The test that guards it
(`'gives every batch a distinct conv_id'`) compares two sequential flushes over an intact file,
which is the only case where the counter works.

**Verified by.** `:110-116` read; the two-process run in `SL-40`, where both flushes carried
`confit:prose:A:0`; `read()`'s `catch` at `:90-95` returning `{}`, which discards `batches`.

**Fix.** `convId: \`confit:prose:${profile}:${randomUUID()}\``. There is no reason for the id to
be derived from durable state at all, and the counter has no other reader.

---

## SL-48 · LOW · D-10's ruling landed buried in the implementation that depends on it, which is §2's rule, whose own paragraph cites SL-12

**Task:** `M20`. **Files:** `docs/confit-v0.8-task-dag.md:219-231` as introduced by `24600d4`;
`src/memory/user.ts:9-12`; `src/memory/writeRead.ts:16`.

**What happened.** PR #65 is one commit. That commit contains `src/memory/proseBuffer.ts`, the
`ProseWrite` contract change, the `AppConfig` change, four rewritten modules, seven touched test
files — and the **thirteen lines that create decision `D-10` itself**: the ruling that loss is
acceptable, that `M17` is closed by decision rather than built, that `M20` becomes the work,
that the buffer is local, and that the receipt must distinguish held from sent. Every argument
this review has had to weigh `M20` against arrived in the same diff as `M20`.

**Why it is a defect.** DAG §2 states the rule and states the reason, in the paragraph this log
is the cause of:

> **Editing this document is an integrator change, and it gets its own commit.** … which is how
> the `D-6` resolution came to be narrowed inside the very PR that implemented `K7` — by the
> agent whose task it describes … (defect log `SL-12`). The substance happened to be right; the
> process was not. … a spec change lands as a commit that does nothing else, so it is
> reviewable as a spec change rather than buried in an implementation diff.

Same shape, same session, same document, four passes later. And the same mitigating clause
applies: the substance is right — `D-10` reads as a genuine product ruling with real
measurements behind it, and the registry note on `M20` is unusually honest. But a reviewer
cannot separate "was this the right call" from "was it implemented" when both arrive as one
blob, and this pass had to reconstruct the boundary of the ruling by reading its wording
closely — which is exactly the work that produced `SL-39` and `SL-40`, where the
implementation quietly exceeds what was sanctioned. A spec commit of its own would have made
that boundary the reviewable artefact it is meant to be.

**Two docblocks now describe machinery this PR deleted.** `verifyPendingProse` and
`dropUnconfirmedProse` are gone, correctly, and `user.ts:80-83` says so. Twenty lines above it,
`user.ts:9-12` still reads: "its **verify-and-retry** holds the text in memory until the
substrate confirms it and dies with the process. … each unconfirmed drop logs a warning." And
`writeRead.ts:16`: "The prose is the personal tier with its own durability story (**M3's
verify-and-retry**), so it is still written." Neither mechanism exists at `24600d4`. `grep -rn
"verifyPendingProse\|dropUnconfirmedProse" src tests` returns one hit — the comment recording
their removal. A module docblock that describes a deleted retry as the durability story is how
the next reader concludes the buffer has one; it has the opposite, by design, and the file's
head paragraph should be the first place that says so.

**Verified by.** `git log --format='%H %s' base..HEAD` → one commit;
`git diff base...HEAD -- docs/` → the `D-10` block;
`grep -rn "verifyPendingProse\|dropUnconfirmedProse" src tests` → one hit, a comment.

**Fix.** Nothing to revert. For the next spec change, one commit that touches only `docs/`, then
the implementation. And rewrite the two stale paragraphs: `user.ts:9-12` should say the prose is
buffered locally, that the buffer's loss is sanctioned by `D-10`, and that there is no retry —
which is the interesting fact about this module and is currently stated only in the file it
delegates to.

---

## Fourth pass — closed by the author, same PR

Every finding above was fixed in `#65` before it merged, so the review changed the shipped code
rather than the backlog. Recorded here because a defect log that only accumulates is a list of
things nobody did.

| id | closed by | note |
| --- | --- | --- |
| SL-39 | one file per confession | No shared document, so there is no read-modify-write to lose a race in. Two concurrent appends never write the same path. |
| SL-40 | claim by `renameSync` | `rename` is atomic and fails `ENOENT` for the loser, so a confession has exactly one owner and the loser takes fewer rather than the same ones. |
| SL-41 | `try` around `ingestBatch` in `writeProse` | Logs `LOST n buffered confession(s)` and throws a message naming `n`, so the count reaches both streams instead of neither. |
| SL-42 | `MEMORY_RECEIPT` | Three states in the UI, matching the CLI. `held` says *where* the words are — "on this device" — not merely that they are late. |
| SL-43 | flush in both branches | `--watch` flushes every pass and totals the count. Red-verified per branch: removing the `--once` call reds two tests, removing the `--watch` call reds the other two. |
| SL-44 | `expect(BATCH_SIZE).toBe(4)` | Pinned to the value. The "failed send" test now asserts a fresh buffer sees nothing; the stray `await Promise.resolve()` is gone. |
| SL-45 | `.gitignore` + honest comment | `.confit/` is ignored. `env.ts` no longer promises a log line that nothing wrote. |
| SL-46 | per-entry parse | A JSON-valid, shape-invalid entry is one skipped file. One lost confession is `D-10`'s accepted loss; a permanently dark personal tier was not. |
| SL-47 | convId from the claimed batch | Derived from an entry name that is unique by construction and already on disk, so nothing has to be remembered across the loss `D-10` sanctions. |
| SL-48 | half | The two stale docblocks are rewritten. The commit-hygiene half is **not** retroactive — `24600d4` still carries the ruling and the implementation together. The `D-10` scope note added this round went in its own commit, which is the rule going forward. |

**What the guards are.** Two structural assertions rather than a re-run of the race: *an append
never touches an existing file*, and *a claimed confession cannot be claimed twice*. Both go red
against the shared-document version (7 of 16 fail). A spawned-process race was written first and
thrown away — against a correct implementation it proves only that the processes did not happen
to collide, which is the kind of test that passes for the wrong reason.

**The decision the review actually forced.** `D-10` says losing a confession is acceptable, and
that sentence was doing work it was never given: it was used to defend destroying confessions
when nothing had failed. `D-10` is scoped to losing **the buffer**. The general rule is now in
the DAG next to the decision — *a decision that accepts a failure mode is not a licence for a
different failure mode that resembles it* — because this will come up again, and the next author
reaching for "the owner said this is fine" should find the boundary written down.

**Measured after the fix.** Four real concurrent `confess` processes: all four accounted for
(three `held`, one `ok`), buffer directory empty, one ingest call carrying all four texts under
one `conv_id`. Before the fix the same shape lost three to five of six.

---

# Fifth pass

**Reviewed the `SL-39`–`SL-48` closures — `2adeae7` and `1c85dbc` on
`claude/upload-code-artifact-zop9uz`, still PR #65 · 25 July 2026**

## What was reviewed

The author's closure claim, and the code under it. `2adeae7` is 12 files, 590 insertions, 136
deletions; `1c85dbc` is six doc lines. `src/memory/proseBuffer.ts` was **rewritten** — the
shared JSON document became one file per confession under a per-profile directory, claimed by
`renameSync` — so it was reviewed as new code rather than as a diff, which is the right
standard for 230 lines that have never been reviewed once.

| gate | result |
| --- | --- |
| `npm test` | **exit 0 — 924 tests, 58 files** |
| `git check-ignore -v .confit/prose-buffer` | **exit 0** (`SL-45` holds) |

The working tree also carries another agent's in-flight `M15` edits to
`src/memory/{user,pool,forget}.ts` and a new `src/memory/scopes.ts`. Nothing below depends on
them; every line cited is at `9b18ddf`.

**One re-open and eight new defects: 2 high, 4 medium, 3 low.** Everything was executed:
six `confess`-shaped processes released against one buffer directory through a spin barrier and
accounted for text-by-text; 30,000 claims raced against an in-flight `writeFileSync`; a
`forget` driven end-to-end against a real buffer and a stub substrate; and two source mutations
run against the full 924-test suite and reverted. Three findings are red-verified by mutation
and say so.

**Seven of the ten closures hold, and two hold well.** `SL-40` is genuinely fixed — the rename
partitions a claim, and no interleaving produced a duplicate. `SL-41`'s count now reaches
stdout, `SL-44` is pinned to the value, `SL-45` is ignored and the false promise is gone,
`SL-46`'s shape-invalid entry costs one confession instead of the tier, `SL-47`'s id is unique
by construction, `SL-48`'s docblocks are honest and the DAG note landed in its own commit. The
`base64url` round-trip guard in `drain` resisted everything thrown at it — `QQ==`, `QQ.`,
`lost+found`, 190 four-letter English words — and the two-line escape test is real.

**And `SL-39` is not fixed.** The author's argument for closing it is a syllogism about paths:
"two concurrent appends never write the same path, so there is no read-modify-write, so nothing
is lost." Both premises are true. The conclusion does not follow, because the loss was never
about two *writers* — it is about a reader and a writer, and the rewrite left that
unsynchronised. `writeFileSync` publishes the pending filename **before** the bytes, a
concurrent `claim` renames the empty file and drops it as unparseable, and `rmSync` removes the
evidence. Measured, on the fixed code: **1 confession in 60 destroyed with nothing having
failed**, and 427 of 30,000 claims against an in-flight write saw a zero-byte file. The rate is
two orders of magnitude better than the 3-to-5-in-6 it replaced. The property `D-10` was
argued not to cover is still violated.

The rest of the pass is the receipt, again. `confess` now prints
`ok (your words, sent to your tier only)` — and the UI prints `written` — from a process that
sent nothing, 9 times in 60 (`SL-49`). And the one place raw confession text now lives is a
place `forget` cannot reach, so `Deleted from Confit` is followed by the next sweep ingesting
the deleted confession (`SL-50`).

## Table

| id | file:line | task | author | sev | one line |
| --- | --- | --- | --- | --- | --- |
| SL-39 | `src/memory/proseBuffer.ts:217`, `:173-184` | M20 | claude-session-014n6NYRN6Rb | high | **RE-OPENED.** `writeFileSync` publishes the name before the bytes; a concurrent `claim` renames the empty file, `JSON.parse('')` throws, the entry is dropped and deleted. **1 of 60** confessions destroyed on the fixed code; 427/30,000 claims saw a zero-byte file. |
| SL-49 | `src/memory/user.ts:165-171`, `src/cli/confess.ts:106-112` | M20 | claude-session-014n6NYRN6Rb | high | `append` loses every rename → `null`; `pending` is then `0`; `0` means "sent". **9 of 60** concurrent confessions printed `ok (your words, sent to your tier only)` having sent nothing. Log line: `held for A — 0/4`. |
| SL-50 | `src/memory/forget.ts:9-13`, `:110-117`, `src/cli/forget.ts:46` | M20 | claude-session-014n6NYRN6Rb | medium | The buffer is a fourth place raw confession text lives and `forget` has three targets. Executed: `forget` reports `ok`, then the next flush ingests the forgotten confession into XTrace. |
| SL-51 | `src/config/env.ts:47`, `src/memory/proseBuffer.ts:213`, `src/config/wiring.ts:186` | M20 | claude-session-014n6NYRN6Rb | medium | The default silently changed from a **file** to a **directory** with no migration. An operator whose `CONFIT_PROSE_BUFFER` points at the file the old docblock described gets `ENOTDIR` out of every `append`, for ever — `SL-46`'s blast radius by a new route. |
| SL-52 | `src/memory/proseBuffer.test.ts:210-222`, `:224-242` | M20 | claude-session-014n6NYRN6Rb | medium | The two guards written *for* `SL-39`/`SL-40` constrain neither mechanism. Red-verified: deleting `randomUUID()` → 924/924 green (and 172/200 two-process runs destroy a confession); deleting the `renameSync` claim → 924/924 green. |
| SL-53 | `src/memory/proseBuffer.ts:146`, `:169-171`, `:182-184`, `:190-192` | M20 | claude-session-014n6NYRN6Rb | medium | Four bare catches in forty lines, not one of which logs — §1's "no silent catch". The module takes no logger, so a destroyed confession leaves no record anywhere and `SL-39`'s recurrence is invisible in the field. |
| SL-54 | `src/memory/proseBuffer.ts:47-48`, `:141-149`, `:253-255` | M20 | claude-session-014n6NYRN6Rb | low | `.taken` files hold raw confession text, nothing ever deletes them, and `pending()` cannot see them — the receipt promised "the next sweep" and no sweep will ever take it. `D-10` sanctions losing the buffer, not retaining it for ever. |
| SL-55 | `src/memory/proseBuffer.ts:125-128`, `:131-134` | M20 | claude-session-014n6NYRN6Rb | low | "Sortable so a flush sends confessions in the order they were made." `seq` is per-process and is always `0001` in the production path, so same-millisecond order is decided by a random uuid. Measured **127 inversions in 300** two-process runs. |
| SL-56 | `src/cli/confess.ts:191-199`, `src/ui/confess/ConfessScreen.tsx:53`, `src/cli/sweep.ts:90-102` | M20 | claude-session-014n6NYRN6Rb | low | `SL-42` is fixed for humans only: `confit confess --json` still emits `wrote.prose: true` and no count. `proseBuffered?` + `?? 0` fails **open** where the neighbouring `wrote?` fails closed. `pass sweep` reports `confessions sent: 0` when a flush destroyed four. |

---

## SL-39 · RE-OPENED · HIGH · the closure claim is a syllogism about paths, and the loss was never about two writers

**Task:** `M20`. **Files:** `src/memory/proseBuffer.ts:217` (`writeFileSync` in `append`),
`:173-184` (the parse-and-drop in `claim`), `:188-192` (`rmSync`), and the closure claim in
`docs/defect-log.md` — "one file per confession … no shared document, so there is no
read-modify-write to lose a race in. Two concurrent appends never write the same path."

**Why the claim is wrong.** Both premises are true and the conclusion does not follow. The lost
confession was never a collision between two *writers*; it is a reader arriving inside a
writer's window, and the rewrite synchronises the readers against each other (`renameSync`) and
the writers against each other (unique names) while leaving reader-against-writer wide open:

```ts
writeFileSync(join(dir, `${entryName(seq)}${PENDING}`), JSON.stringify({ text }));   // :217
```

`writeFileSync` is `open(O_CREAT|O_TRUNC)` then `write`. The pending name — the name
`pendingNames()` matches on, `.json` — therefore exists, and is **zero bytes**, before the
confession is in it. Another process's `claim` at that instant does exactly what it is written
to do: renames it (succeeds, the name exists), reads `''`, `JSON.parse('')` throws, the `catch`
at `:182` drops the text with the comment "One lost confession, which D-10 accepts", and
`rmSync` at `:189` deletes the only copy.

**Measured, on the fixed code, twice.**

*The window.* One process writing 30,000 realistic confession bodies; another claiming each one
with the module's own two steps, `renameSync` then `readFileSync`:

```
claimed 30000 in-flight files: empty=427 unparseable-partial=0
  => confessions the claim would DROP and DELETE: 427
```

1.4%. Nothing was corrupt, nothing failed, no disk went away.

*End to end.* Six processes, each `createProseBuffer({path}).append('A', textN)` — one append
per process, which is what `confess` is — released through a spin-wait barrier on a shared
timestamp, ten trials. Every text accounted for against the union of what any process flushed
and what a final `drain()` found:

```
trial 3: reported=6 DESTROYED=["c4"] leftover-files=[]
...
confessions destroyed with nothing failing: 1/60
```

**Why this is a re-open and not a new number.** It is the same defect as `SL-39`: an ordinary
burst of concurrent `confess` processes destroys a confession that the diner was told was
recorded. The mechanism moved from the shared document to the create-then-write window, the
rate dropped from three-to-five-in-six to one-in-sixty, and the log's own scope rule — added to
the DAG by this very author in `1c85dbc`, "a decision that accepts a failure mode is not a
licence for a different failure mode that resembles it" — says one-in-sixty is the same
category as three-in-six, not a smaller version of an accepted loss.

**And the docblock waves at exactly this.** `:50-51`: "The rename is not ceremony against torn
writes, which is what `D-10` declined." That sentence dismisses the only hazard left in the
file. A torn write here is not a lost *buffer*; it is one confession destroyed while everything
was working, which is the distinction the author wrote six lines of DAG to establish.

**Combine with `SL-49` and `SL-53` for the shipped experience.** The destruction is silent —
`proseBuffer` has no logger and the `catch` is bare — and the process whose confession was
destroyed can print `ok (your words, sent to your tier only)`. Nobody will ever know.

**Verified by.** `renameSync`-then-`readFileSync` against an in-flight `writeFileSync`, 30,000
iterations, 427 zero-byte claims; the six-process barrier race, 10 trials, `DESTROYED=["c4"]`
in trial 3 with an empty buffer directory afterwards; `:173-184` and `:217` read at `9b18ddf`.

**Fix.** Two lines, and it is the same primitive already in the file. Write to a name
`pendingNames()` cannot match, then `renameSync` it into place:

```ts
const tmp = join(dir, `${name}.writing`);
writeFileSync(tmp, JSON.stringify({ text }));
renameSync(tmp, join(dir, `${name}${PENDING}`));
```

A pending name then never exists until the bytes are complete, which is the property the file
already relies on for the claim. Whatever remains after that is genuinely `D-10`'s.

---

## SL-49 · HIGH · `confess` prints "sent to your tier only" from a process that sent nothing, nine times in sixty

**Task:** `M20`. **Files:** `src/memory/user.ts:165-171`, `src/memory/proseBuffer.ts:219-222`,
`src/memory/writeRead.ts:118-125`, `src/cli/confess.ts:106-112`,
`src/ui/confess/ConfessScreen.tsx:34-36`.

**The path.** `append` decides to flush on a file count, then claims — and a claim can come
back empty because another process renamed everything first:

```ts
if (pendingNames(profile).length < BATCH_SIZE) return null;
const claimed = claim(profile, BATCH_SIZE);
if (claimed === null) return null; // Another process took the batch; ours is in it.   // :222
```

`writeProse` then treats `null` as "held" and asks how many are waiting:

```ts
const held = deps.buffer.pending(profile);                                    // user.ts:167
deps.logger.line(`user: confession held for ${profile} — ${held}/4 …`);      // :168-170
return { buffered: held };                                                   // :171
```

When the other process claimed *everything*, `held` is `0`. And `0` is the wire value for
**sent**: `writeRead` reports `proseBuffered: 0` with `wrote.prose = true`, `confess.ts:110`
renders `proseBuffered === 0` as `ok (your words, sent to your tier only)`, and
`ConfessScreen.tsx:36` renders it as `written`. The comment at `:222` — "ours is in it" — is
the author's own note that this process did not send anything.

**Measured.** The same six-process barrier race, ten trials, each child printing exactly what
`writeProse` would return:

```
trial 3: false-"sent"=["c2","c4","c5"]
trial 5: false-"sent"=["c0","c1","c4"]
trial 8: false-"sent"=["c0","c4"]
trial 6: false-"sent"=["c2"]

receipts claiming "sent to your tier only" by a process that sent nothing: 9/60
```

**Why it is HIGH and not a wording nit.** This is `SL-42` inverted, and `SL-42` was filed HIGH.
`D-10`'s write-up names one consequence the owner should see rather than discover — "a buffered
confession has **not** reached XTrace when `confess` prints its receipt … the receipt must say
which of the two it is" (DAG `:230`). The fix taught the receipt to say `held`, then left a path
where it says `sent` for a confession that at best is in someone else's in-flight POST and at
worst was destroyed by `SL-39` a millisecond earlier. In trial 3, `c4` is in **both** lists: it
was destroyed, and it printed `ok — sent to your tier only`. There is also no honest reading of
the stderr line `user: confession held for A — 0/4 until the batch is sent`; it says held and
says zero in one sentence.

**Verified by.** 10 trials × 6 spawned processes against the real
`createProseBuffer`/`append`/`pending`, reproducing `writeProse`'s branch verbatim; the four
cited source ranges read at `9b18ddf`.

**Fix.** `append` already knows which of the two happened, and it throws the knowledge away by
returning `null` for both. Return the distinction — a `Flush | 'held' | 'taken-by-another'`, or
simply have `writeProse` not turn `pending === 0` into `buffered: 0`. A confession this process
neither sent nor holds is not "sent"; the true statement is that it is in another process's
batch, and the receipt has a wording slot for that already (`held`).

---

## SL-50 · MEDIUM · `forget` has three targets and the raw confession now lives in a fourth, so "Deleted from Confit" is followed by ingesting it

**Task:** `M20`. **Files:** `src/memory/forget.ts:9-13`, `:110-117`, `src/cli/forget.ts:46`,
`src/memory/proseBuffer.ts:217`.

**What M20 changed about deletion, without touching the deletion path.** Before this PR, a
confession's raw prose existed in memory for the length of one process and was ingested
immediately. Now it sits on local disk — unencrypted, by design, and the module says so — until
a batch fills or an operator sweeps. `forget` was not told. Its targets are `pool`, `relay` and
`user` (XTrace user scope), and `forgetUser` deletes only against caller-supplied handles.

**Executed**, real `createProseBuffer` + real `createUserStore` + stub substrate:

```
after confess: {"buffered":1} (receipt: held on this device)
forget report: {"pool":"skipped","relay":"nothing_to_delete","user":"skipped","ok":true}
buffer still holds it: 1
next `pass sweep` ingested 1 confession(s) AFTER the forget
  XTrace now holds under confit:prose:A:001784990770611-0001-8feb5678-…:
    ["I only order the tasting menu when my ex is watching."]
```

`ok: true`, so `cli/forget.ts:46` prints `Deleted from Confit: <read_id>`. Then the next
`confess` for that profile, or the next `pass sweep`, POSTs the forgotten text into the
substrate the user just asked to be cleared of it. Deletion followed by ingestion of the
deleted thing is a worse shape than the one this log has cited three times — `forget` printing
"Deleted from Confit" over two skipped targets — because the count of copies goes *up* after
the user acts.

**And the module docblock is now false.** `forget.ts:11-13`: "The **relay** delete is the
authoritative one … once its entry is gone the read is gone from every place that can produce
it." There is now a place that can produce it, on the same machine, after the relay entry is
gone.

**Not merely an omission — currently unimplementable.** A buffer entry is `{"text": "…"}`
(`proseBuffer.ts:217`). It carries no `read_id`, so a fourth target could not identify which
file to delete even if one existed. Closing this needs the entry to carry the `read_id`
`writeRead` has in hand at `:120`, which is a format change, which is why it needs to be
written down rather than noticed later.

**Verified by.** The transcript above, `npx tsx` against the real modules;
`grep -rn "prose\|buffer" src/cli/forget.ts src/memory/forget.ts` → no buffer reference;
`forget.ts:110-117` and `cli/forget.ts:40-46` read.

**Fix.** Two honest options. (a) `forget` takes the buffer and drops the profile's pending
entries, and the entry format grows a `read_id` so it can drop *that* confession rather than
all of them. (b) If (a) is out of scope, the copy stops claiming completeness and
`forget.ts:11-13` stops claiming the relay delete is authoritative — with `D-10`'s window named,
because "your words may be sent to your memory after you delete them, until the next sweep" is
a product decision and not an implementation detail.

---

## SL-51 · MEDIUM · the default buffer path silently changed from a file to a directory, and an operator who took the docblock's invitation gets `ENOTDIR` for ever

**Task:** `M20`. **Files:** `src/config/env.ts:42-47`, `src/memory/proseBuffer.ts:211-213`,
`src/config/wiring.ts:186`.

**What changed.** `DEFAULT_PROSE_BUFFER_PATH` went from `.confit/prose-buffer.json` to
`.confit/prose-buffer`, and the meaning of `CONFIT_PROSE_BUFFER` went from *a file* to *a
directory*. `env.ts` documents the new meaning in capitals. Nothing migrates, nothing detects
the old shape, and nothing warns.

**Two consequences, both executed.**

*(a) The old buffer is orphaned, and it is the most sensitive text in the product.* Anyone who
ran the previous build has `.confit/prose-buffer.json` holding raw confessions. The new code
reads `.confit/prose-buffer`, so those confessions are never sent and never deleted; they sit
on disk indefinitely, and `.gitignore`'s `.confit/` — added for `SL-45` — now also guarantees
nobody notices them.

*(b) An operator-set path that points at a file kills the personal tier permanently.*
`CONFIT_PROSE_BUFFER` exists so "an operator can put it somewhere they control", and until this
commit the thing to control was a file. Point it at one:

```
root-is-file pending: 0
root-is-file drain:   []
root-is-file append:  THREW ENOTDIR: not a directory, mkdir '/tmp/…/prose-buffer.json/QQ'
```

`mkdirSync` at `:213` throws out of `append`, out of `writeProse`, into
`writeRead.ts:122` — `prose write failed — personal memory not recorded` — and `confess`
carries on with exit 0. Every future confession's prose is discarded, one warning line at a
time, with no self-heal and no `pass` command that repairs it; and `pending`/`drain` return
`0`/`[]` on that path, so `pass sweep` reports nothing wrong. That is `SL-46`'s finding
verbatim — "a `confit` install where every future confession's prose is silently discarded,
forever … the only symptom is a per-target FAILED that looks like an XTrace outage" — filed at
medium, closed as fixed, and reachable again through the shape the fix introduced. The sibling
case is the same: a profile directory that exists as a file gives `EEXIST` from the same
`mkdirSync`.

**And the file that constructs the buffer still thinks it is a file.** `wiring.ts:186` passes
`join(mkdtempSync(…), 'prose.json')` as the buffer root, so the fixture graph now creates a
*directory* named `prose.json`. Harmless, and it is evidence the rename was applied to the
default and not to the idea.

**§2, while we are here.** `src/config/**` and `.gitignore` belong to the Foundation/integrator
lane — "If your task needs a file outside your lane's list, that is a contract change: raise
it, don't take it." A semantic change to the meaning of `AppConfig.proseBufferPath` is exactly
that, and it landed inside a lane-M implementation commit with no note. `SL-48` closed as
"half"; this is the other half recurring in the fix.

**Verified by.** `npx tsx` against the real module for the `ENOTDIR` and `EEXIST` transcripts;
`env.ts:42-47` and `wiring.ts:186` read; `git show 24600d4:src/config/env.ts` for the previous
default.

**Fix.** Detect it rather than crash on it. `append` catching `ENOTDIR`/`EEXIST` on the root and
throwing a message that names the path and says "this must be a directory; the pre-M20 buffer
was a file" costs three lines and turns a permanent silent outage into one legible error. Then
migrate or delete the old file, and say which in the release note.

---

## SL-52 · MEDIUM · the two guards written for SL-39 and SL-40 constrain neither mechanism — both defects are restorable with 924/924 green

**Task:** `M20`. **File:** `src/memory/proseBuffer.test.ts:210-222`, `:224-242`.

The author's claim: "Two structural assertions rather than a re-run of the race: *an append
never touches an existing file*, and *a claimed confession cannot be claimed twice*. Both go
red against the shared-document version (7 of 16 fail)." Going red against a *different
implementation* is not a guard; it is a coincidence of that implementation failing many things
at once. The standard `SL-44` established is mutation against the code as written. Applied:

**Mutation 1 — delete the uniqueness that the whole fix rests on.**

```ts
-  return `${stamp}-${String(seq).padStart(4, '0')}-${randomUUID()}`;
+  return `${stamp}-${String(seq).padStart(4, '0')}`;
```

`npx vitest run` → **924 passed (924)**. Nothing notices. And the mutation is not cosmetic: in
the production path each `confess` process appends exactly once, so `seq` is `0001` in every
process, and two processes in the same millisecond choose the **same filename** — the second
`writeFileSync` overwrites the first:

```
confessions destroyed in 172/200 two-process runs (suite still green)
```

`SL-39`, fully restored, at 86%, invisible to the suite. `an append never touches an existing
file` cannot see it because it runs one buffer in one process, where `seq` differs.

**Mutation 2 — delete the atomic claim.**

```ts
-      const to = `${from}${TAKEN}`;
-      try { renameSync(from, to); } catch { continue; }
+      const to = from; // no atomic claim: read then delete in place
```

`npx vitest run` → **924 passed (924)**. That is `SL-40` restored — two claimers read the same
file before either deletes it, and the same confession goes into two batches — with the test
named `a claimed confession cannot be claimed twice` still green.

**Why that test cannot go red.** Read it: `one.drain()` runs to completion, *then*
`two.drain()` runs. Both are synchronous. There is no interleaving of any kind, so it asserts
"draining twice does not return the same text twice" — which line `:99` of the same file
already asserts, in a test about something else. Its own comment says it "stand[s] in for two
processes crossing the threshold together"; it does not. Any implementation that removes a file
after reading it partitions two *sequential* drains perfectly, including every racy one.

**Verified by.** Both mutations applied to `src/memory/proseBuffer.ts`, full suite run, both
reverted (`git status` clean on that file); the 172/200 loss measured under mutation 1;
`:224-242` read line by line.

**Fix.** The two properties that matter cannot be observed from one process, so stop trying to
observe them structurally and observe them for real: the spawned barrier race in this pass took
40 lines, runs in seconds, and caught two live defects. If a spawned race is genuinely
unwanted, then at minimum assert what a single process *can* see — that two `entryName()` calls
with the same `seq` and the same clock differ, and that a claimed file no longer exists under
its pending name — because both mutations above break exactly one of those.

---

## SL-53 · MEDIUM · four bare catches in forty lines, none of which logs, in the module that decides whether a confession still exists

**Task:** `M20`. **File:** `src/memory/proseBuffer.ts:146`, `:169-171`, `:182-184`, `:190-192`.

§1: "**No silent catch.** Either handle an error meaningfully or let it propagate. A degrade
path is a handled error and **must log which flag it flipped**." The four catches in this file:

| line | swallows | consequence |
| --- | --- | --- |
| `:146` | any `readdirSync` failure | `pending()` → `0`, which `SL-49` renders as **sent** |
| `:169-171` | any `renameSync` failure | the confession is skipped, for ever, on `EACCES`/`EIO` as readily as on the intended `ENOENT` |
| `:182-184` | any read or parse failure | the confession is **destroyed** — this is `SL-39`'s exit wound |
| `:190-192` | any `rmSync` failure | raw confession text stays on disk after being sent |

None writes a line. The module takes no logger — `ProseBufferOptions` is `{ path }` — so it
cannot, and `SL-45`'s fix resolved the "the path is logged on first write" lie by **deleting
the promise** rather than adding the line. The result is that the highest-value event in this
subsystem, *a confession ceased to exist*, is unobservable: not in stdout, not in stderr, not
on disk.

**The precedent is one file over and in this PR's own diff.** `SL-46`'s fix in `user.ts:270`
skips a malformed meal-log entry **with a line**: `user: skipping malformed meal-log entry #N
for A`. The same author, the same commit, the same class of degrade, and the buffer's version
of it is a comment: `// Unreadable or not JSON. One lost confession, which D-10 accepts.` A
comment is not a log; nobody reads the source of a running install.

`:169-171` deserves its own sentence. It is written for one cause — "Another process owns this
one" — and catches every cause. A directory that has become unwritable, a filesystem returning
`EIO`, a `.taken` name colliding: all become "someone else has it, they will send it", and
nobody ever does.

**Verified by.** The four ranges read at `9b18ddf`; `grep -n "logger\|console"
src/memory/proseBuffer.ts` → no match; `ProseBufferOptions` at `:86-92`; the `user.ts:270`
precedent in the same commit. The `readdirSync`-denied case is reasoned from `:146`, not
measured — this container runs as root, where `chmod` does not bind.

**Fix.** Give the buffer the `Logger` every other module in the lane takes, and log the drop —
the profile, the entry name, the reason — at `:182`. One line there would have turned `SL-39`'s
recurrence from a defect found by a reviewer with a barrier script into a defect found by the
first operator who read stderr.

---

## SL-54 · LOW · `.taken` files hold raw confession text for ever, and `pending()` counts files rather than confessions

**Task:** `M20`. **File:** `src/memory/proseBuffer.ts:47-48`, `:141-149`, `:253-255`.

**The leak.** A process that dies between `renameSync` (`:168`) and `rmSync` (`:189`) leaves
`<name>.json.taken`. `pendingNames()` filters on `.endsWith('.json')`, so a `.taken` file is
never re-listed — correct, no duplicate send — and also never listed by anything else, because
nothing else looks: `grep -rn "taken\|TAKEN" src` outside this module returns nothing. There is
no cleaner, no age sweep, no `pass` command. The docblock at `:47-48` calls it sanctioned: "a
process that dies mid-flush leaves `.taken` files that nothing will ever pick up. Both are the
sanctioned cost."

**They are not the same cost.** `D-10` sanctions *losing* the buffer. A `.taken` file is the
opposite failure mode: the most sensitive text in the product **retained**, unencrypted, in a
`.gitignore`d directory, past the point where any code path will ever look at it or delete it,
on a machine that will accumulate one per unlucky crash for as long as the install lives. That
is the distinction the author wrote into the DAG in `1c85dbc` — "a decision that accepts a
failure mode is not a licence for a different failure mode that resembles it" — pointed at
their own docblock. And it compounds `SL-50`: `forget` cannot reach a `.json` entry, and it
certainly cannot reach a `.taken` one.

A leaked `.taken` is also a receipt that will never come true. The diner was told
`held (with 2 of yours — sent together, or on the next sweep)`. No sweep will ever take it, and
`pending()` reports it as gone, so the count the next confession prints is quietly short.

**And the count is a file count.** `pending()` is `pendingNames(profile).length` (`:253-255`),
which reads no file. So the residue of `SL-46`: three shape-invalid entries plus one real one
report `held (with 4 of yours)`, and the flush that follows carries **one** text — `drain`
deletes the other three rather than sending them. `proseBuffer.test.ts:136` pins this
(`expect(buf.pending('A')).toBe(3)` over one real entry and two junk ones) — the test asserts
the wrong number is returned rather than noticing it is wrong. Low, because it needs corruption
to reach; recorded because `SL-46`'s closure line says "one bad entry is now one lost
confession" and one bad entry is also one over-reported pending count. Empty profile
directories are the same shape and cost nothing: `drain()` re-lists and re-decodes every one on
every sweep, for ever.

**Verified by.** `grep -rn "taken\|TAKEN" src --include=*.ts` → one file; `:141-149` and
`:253-255` read; `proseBuffer.test.ts:125-142` read.

**Fix.** For the leak: on `drain()`, delete `.taken` files older than a bounded age, and say in
the docblock that the bound exists — a spool with no cleaner is the one durability property
this design cannot decline, because it is about retention rather than delivery. For the count:
`pending()` returning a count that `drain()` will not deliver is a lie in the one number the
receipt prints; parse-on-count or stop calling it a confession count.

---

## SL-55 · LOW · "sends confessions in the order they were made" is decided by a random uuid in the only path that matters

**Task:** `M20`. **File:** `src/memory/proseBuffer.ts:120-128`, `:131-134`.

**What the code claims.** `:120-123`: "Sortable so a flush sends confessions in the order they
were made — the batch becomes one conversation, and a conversation out of order reads as a
different conversation." And `:131-134`: `seq` "exists so two appends inside a single
millisecond still sort in the order they were made, which `Date.now()` alone does not give."

**Why the second sentence is false in production.** `seq` is a closure variable, per
`ProseBuffer` instance, per process. Every confession arrives in its own CLI process — the
premise of this entire module, stated at `:14-15` — and each process appends exactly **once**.
So `seq` is `0001` in every production entry name, and never breaks a tie. The tie-break that
actually runs is the third field: `randomUUID()`.

**Measured.** Two buffers at one path standing in for two processes, `FIRST` appended before
`SECOND`, 300 trials:

```
ordering: trials=300 same-millisecond=258 out-of-order=127
```

258 of 300 pairs landed in the same millisecond, and 127 came back to the caller in the wrong
order — a coin flip, as designed, since a v4 uuid is where the comparison lands. The batch that
becomes "one conversation" is shuffled, which the docblock itself says makes it a different
conversation.

**Scope.** Low: two humans confessing inside the same millisecond is not the demo. Two
*processes* are, though — the author's own verification is "four CONCURRENT `confess`
processes", and that run had a 50/50 order for any same-millisecond pair. The reason to fix it
is not the frequency; it is that a comment explains a mechanism that does not operate, and the
test that pins ordering (`:39-48`) runs one process, where `seq` does the work and the uuid
never decides anything.

**Verified by.** The 300-trial measurement above against the unmodified module; `:125-128` and
`:131-134` read; `proseBuffer.test.ts:39-48` read.

**Fix.** Either sort by something real — write `{"text":…, "at": Date.now()}` and order the
claimed batch by `at`, with the entry name only needing uniqueness — or delete the ordering
claim and the `seq` comment, and let the docblock say that within a millisecond the order is
arbitrary. What is not tenable is a stated invariant whose stated mechanism is inert.

---

## SL-56 · LOW · SL-42 is fixed for humans; the machine receipts still say "written", and `pass sweep` says "0 sent" for four destroyed

**Task:** `M20`. **Files:** `src/cli/confess.ts:191-199`, `src/ui/confess/ConfessScreen.tsx:53`,
`:168`, `src/cli/sweep.ts:90-102`, `src/memory/user.ts:291-306`.

**(a) `confit confess --json` cannot tell held from sent.** `render.ts:50-51` prints `data` and
nothing else for `--json`, and confess's `data` is
`{blocked, approved, read_id, chips, wrote, warnings, pooled}` — `proseBuffered` is not in it,
though `writeRead` returns it and the human lines four lines above consume it. So the payload
says `wrote.prose: true` for a confession sitting on local disk: the exact `SL-42` sentence
("`wrote.prose` is `true` for a buffered confession as much as a sent one, so it cannot carry
this on its own"), left standing in the surface `--json` exists for. DAG §5: "`--json` on every
command for tests" — a test or script cannot assert the held/sent distinction this PR was
written to create.

**(b) `ConfessOutcome.proseBuffered` is optional and fails open.** `:53` declares
`proseBuffered?: number`; `:168` renders `phase.outcome.proseBuffered ?? 0`; `memoryLine`
renders `0` as `written`. So an outcome that omits the field renders the `SL-42` defect exactly.
Compare the neighbour on the same line: `wrote?.prose === true` — also optional, and it fails
**closed** to `not written`. The mirror of this type in `writeRead.ts:53` has
`proseBuffered: number`, required. The only `UiBackend` in the repo is `NOT_CONNECTED`, whose
`submit` rejects, so today nothing but tests supplies the field — which means the `?` exists to
let call sites omit it, and the first real backend that does will re-ship `SL-42` and typecheck
clean. Make it required and the compiler enforces the fix instead of the reviewer.

**(c) `pass sweep` reports `confessions sent: 0` when a flush destroyed four.**
`user.ts:291-306` swallows every `ingestBatch` failure and returns only `sent`, so a flush that
claimed four confessions, deleted them and lost the POST returns `0`. `sweep.ts:118-119` prints
`confessions sent:     0` and emits `confessions_sent: 0`, exit 0 — indistinguishable from an
empty buffer. The only trace is a stderr `logger.line` from `user.ts`. `confess` does better: it
surfaces the loss into its own receipt as `! prose write failed …`. Two receipts over one
failure, one of which mentions it.

The same asymmetry makes the sweep's own safety net decoration: because `flushProse` never
rejects, `sweep.ts:92-101`'s catch cannot fire in production, and the test that covers it
(`sweep.test.ts` — "`--once` still sweeps when the flush throws") stages a rejection the
production wiring cannot produce. The `--watch` loop would also log that unreachable line once
per pass for ever, which is only not a defect because it is unreachable.

**Verified by.** `confess.ts:191-199` and `render.ts:49-55` read; `ConfessScreen.tsx:34-36`,
`:53`, `:168` read; `grep -rn "UiBackend" src` → one implementation, `NOT_CONNECTED`;
`user.ts:291-306` and `sweep.ts:90-119` read.

**Fix.** Put `proseBuffered` in confess's `data`; make `ConfessOutcome.proseBuffered` required;
have `flushProse` return `{sent, lost}` and print both, because a sweep that destroyed four
confessions and a sweep that had nothing to do must not render identically.

---

## Sixth pass — one finding against the M10 tail (`0562ca7..dcac032`), by a different reviewer

The fourth and fifth passes stopped before the commits that closed them, so the M10/M13/P0.10/P0.12 tail shipped unreviewed. fable-session-0dd9z8 read it at `dcac032`; one defect survived contact. Full context on the PR #65 thread (third-pass comment).

## SL-57 · MEDIUM · claude-session-014n6NYRN6Rb sequenced the ledger read before the deletes, then let the delete that fails orphan what the ledger was for

**Closed** by fable-session-0dd9z8 in the same change that records this entry: `forgetPool` now attempts every handle (not stopping at the first failure), a partial failure carries the undeleted handle ids and the by-hand instruction in `pool.detail`, and the no-handles `skipped` message distinguishes "entry present, sweep will record handles" from "entry gone, no sweep ever can" — the latter stated as unreachable rather than advised into a retry loop that cannot work.

**Task:** M10. **Files:** `src/memory/forget.ts` (`forgetPool`, `poolHandles`).

**What the code did.** `poolHandles` correctly resolved the ledger before any delete — the SL-49-era race fix is real. Then `forgetPool` and `forgetRelay` ran in one `Promise.all`, and the ledger's only durable copy lives ON the relay entry `forgetRelay` deletes. Walk the failure: three handles read; XTrace 503s on handle two → `pool: failed` with a bare error message, handles two and three undeleted, loop abandoned at the first throw. `forgetRelay`, in parallel, has already dropped the entry. The user re-runs `forget`, as the report invites: `poolHandles` finds no entry → `handles: []` → `pool: skipped` with **"run `confit sweep` and forget again (M10)"**. There is no entry left to sweep; no sweep will ever re-record those handles; the derived memories sit in the pool scope permanently, reachable by no code path — while the advice implies the opposite.

**Why it is wrong.** The file's own docblock names the one forbidden bug: a deletion report that overstates itself. The first-run `failed` is honest; the steady state after it lies — `skipped`-with-impossible-advice is indistinguishable from the fresh-confession case where the advice is exactly right. The relay delete is not the mistake (stopping the counting must not be hostage to XTrace flakiness); the mistake is discarding the only remaining copy of the handles into a bare error string and then advising a retry that reads from the place both copies just left.
