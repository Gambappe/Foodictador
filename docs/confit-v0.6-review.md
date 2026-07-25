# Confit design v0.6 — review

**Review of `docs/confit-design-v0.6.md`, against implementation plan v1.0 (`docs/confit-implementation-plan.md`, governed by design v0.3) · July 25, 2026 · reviewer: Claude, for the Foodictador team**

**Verdict: adopt v0.6 for the slice, with three conditions.** It is a better design than the v0.3 lineage we're currently building against, and better for the most convincing reason possible: it was tested against the live substrate and our current plan wasn't. Its evidence appendix falsifies four assumptions plan v1.0 is built on. But it carries two regressions it declares honestly, one gap it doesn't declare at all — the peak demo beat cannot cross devices as specced — and one internal tension worth recording for [prod]. The conditions are in §5; none of them is expensive.

---

## 1. What v0.6 gets right (adopt regardless of anything else)

Four assumptions in plan v1.0, falsified by v0.6's direct testing:

| Plan v1.0 assumes | v0.6 measured |
|---|---|
| x-vec is buildable (T0.3 spike, A3 vault adapter, `xvec` pot backend) | Unbuildable: the SDK's admin URL is NXDOMAIN from public DNS, so KB creation fails for everyone; Python 3.11+ only, browser-incompatible; sign-only quantization is a 32× information loss (§14) |
| An encrypted vault coexists with platform extraction | Mutually exclusive: 0 memories extracted from AES-GCM input vs 11 from the same plaintext (§14) |
| Pot freshness < 3 s — B2's literal acceptance criterion | XTrace ingest→retrievable is 5–8 minutes, consistently (§14) |
| The narrator runs on `claude-sonnet-4-6` (C2, §7 Lane C) | That model doesn't exist. `claude-sonnet-5` does — [E13] is correct, and our plan carries the bug |

Plan v1.0 already hedged the first row (Gate 1's `local` fallback; §2.1a took embeddings off the demo spine). v0.6 proves the hedge would have fired and deletes the dead weight up front — that's strictly better than discovering it at 1:10 on build day.

Beyond the falsifications:

- **Deleting client-side encryption removes our entire Lane A** — keys, vault, x-vec adapter, destroy-key — from a 5-hour budget. The doc's own estimate that this was "roughly the hardest 40%" of the build matches our task table.
- **[E10] is coherent, not spin.** Making the k≥5 cohort floor the primary privacy defense is honest bookkeeping: in our demo script the floor was already the load-bearing protection (the cohort-miss line, the never-cite-below-k rule). Encryption protected the store; the floor protected the person.
- **The architecture findings are exactly what only testing surfaces**: the synthetic pool user (because group-scoped search returns zero episodes), reserving episode slots (facts crowd out episodes in a flat top-k), always passing `user_id`. Any of these would have burned an hour mid-build.

## 2. The two regressions it declares honestly

**The privacy proposition is genuinely weaker.** "Nobody can read this" becomes "we hold this, and we don't sell or expose it." v0.6 re-grounds the wedge on collection design — the audience-free prompt — and argues that's where it actually held. That's a defensible product judgment, and §1's argument for it is good. But it is the largest strategic concession in the doc, and the Reveal beat downgrades from *here is your ciphertext* to *find your sentence in the pool rows* — still a beat, weaker theater. Whoever demos should rehearse the §12 answer to "what stops this identifying me?" until the cohort floor sounds like a confident answer rather than a fallback.

**Durability becomes a correctness risk.** 11/16 non-deterministic retention on what is now the *sole* store means reads silently vanish — including a judge's, and including reads a user believes they contributed and may later try to delete. Verify-and-retry [E12] is the right mitigation, but §13 admits the recovery path (does re-ingest actually recover a dropped read?) is **untested**, at an estimated twenty minutes of work. Our current design's stores were dumb but deterministic; this trade should not be accepted on an untested mitigation. See condition 2.

## 3. The gap v0.6 does not declare: the peak beat can't cross devices

The demo's climax requires the judge's read to tip a near-tied ranking **on a stranger's phone, within seconds** (§5: "tipping a near-tied ranking on a stranger's phone"). Walk the mechanism as specced and it doesn't get there:

- XTrace settle is 5–8 minutes, so the pool tier can't carry the live read in time.
- The write-through buffer — v0.6's stated answer — is "session memory," "session-local" (§6). A buffer on the judge's device cannot appear in account B's union.
- The demo timeline this plan inherits leaves ~35 seconds between the confess beat and the cross-account reorder (plan v1.0 §1, beats 0:55 → 1:30).

As written, the reorder either doesn't happen on B's phone or the demo stalls for six minutes on stage — which §12 itself names as "the demo dying on stage," just under a different risk heading.

**The fix is small and we've already specced it.** Keep plan v1.0's pot-relay (§8.4, the ~60-line KV service) as a *shared* un-settled-read buffer: approved reads are written to XTrace (durable, both scopes) **and** to the relay; every Ask on every device unions relay contents over XTrace results; a relay entry is deleted once its read verifies as retrievable — the [E12] verify-and-retry loop already produces exactly that signal. The relay then only ever holds the 5–8 minute settle window, carries only the identity-free five-field object (§7's shape, consistent with the [E9] posture), and XTrace remains the sole durable store. This costs one deploy at hour zero and rescues the peak beat.

## 4. Two calibration notes

**Don't cite "8/8 vs 2/10" at slice scale.** [E11]'s raw-prose claim is undercut by v0.6's own standing caveat: the 2×2 test found *no significant difference* between prose and pre-structured input at ~30 records. The honest justification for raw-prose ingest in the slice is **simplification** — one less seam, one less call — not measured quality. Fine, but the demo script and any judge Q&A should not lean on the number.

**The pool is permanently confined to the "worst" input format — flag it for [prod].** By [E9]/§7, the pool can only ever receive the structured five-field object; the raw narrative is precisely what must not be pooled. Per §14, structured input is the worst-extracting representation — immaterial at slice scale (the caveat says so), but the same caveat says format "only matters as the pool grows." So the pool's extraction quality and its privacy construction are in structural tension at exactly the scale where the pool becomes valuable. Not a slice problem; it belongs in §13's open questions rather than left implicit.

## 5. Conditions for adoption

1. **Amend §6: make the write-through buffer shared, not session-local** — the relay-backed design in §3 above, deployed at hour zero alongside the latency measurement.
2. **Run the re-ingest recovery test before the build day** (§13's own twenty-minute item). If re-ingest doesn't recover a dropped read, [E12]'s mitigation is fictional and the durability trade needs rethinking while there's still time to rethink it.
3. **Keep plan v1.0's degrade flags** (§3.3: `extraction: seeded`, `narrator: template`, and now `pool: relay-only`). v0.6 concentrates store + extraction + induction on one substrate; the flags are what turn an XTrace incident on stage into a disclosed fallback instead of a dead demo.

One recommendation short of a condition: **repurpose the boundary interceptor (A4) instead of deleting it.** In v0.6's world the structural privacy claim is "identity separation by construction" — pool writes contain only the five fields, no narrative, no profile linkage. That is exactly what a fetch interceptor can assert in CI: any request toward the pool scope containing narrative text or a profile `user_id` fails the build. Plan v1.0's principle that the privacy boundary is "enforced by tooling, not vigilance" (§5) survives [E9] intact — it just guards a different boundary now.

## 6. What adoption does to plan v1.0

**Survives largely untouched:** deterministic scoring and the CI-protected near-tie invariant (§3.4, `neartie.test.ts`), Rotation (§3.5), the nudge rules, the duty-of-care operational layer (copy linter, CI regression, off-limits propagation test — now first-commit items per v0.6 §9), most of the E-lane UI, The Pass, and the seed corpus with its near-tie tuning.

**Dies or transforms:** Lane A (A1–A5) and T0.3 die; B-lane becomes an XTrace adapter (pool user, reserved episode slots, explicit `user_id`) plus the shared buffer; C1 shrinks to chip preview; C2 moves to `claude-sonnet-5`; C3 dies; hour zero becomes *measure ingest latency, verify retrievability, seed immediately* [E6/E12]; seeding becomes an ops step hours ahead of the demo rather than a fixture load; Reveal is redesigned around the find-your-sentence challenge; acceptance rows S1/S5 rewrite; S2 gains the buffer as its transport.

**Process consequence:** the workstream-lock registry currently seeded from plan v1.0's §4 DAG (32 tasks) needs reseeding once a v2.0 plan exists — several lanes vanish, the hour-zero tasks change shape. Half a day of planning work, and the lock tooling itself (`docs/workstream-locks.md`) carries over unchanged.

---

*Bottom line: v0.6 is the better design — smaller, honest about its trades, and grounded in evidence where v0.3 was grounded in intention. Fix the cross-device buffer on paper before anyone builds against §6, run the twenty-minute recovery test, keep the degrade flags, and it's the doc to build from.*
