/**
 * XTrace scope names, and the generation marker that lets a bad scope be abandoned (M15).
 *
 * ## Why a generation exists
 *
 * A scope accumulates episodes, and an episode is a *synthesis of the ingests that produced
 * it* — so when the shape of what gets ingested changes, the old episodes do not become
 * stale, they become **competition**. Measured twice on the live substrate:
 *
 *  - `confit:pool` — the pre-M12 per-read JSON ingests produced episodes like "The session
 *    contains a single structured event rather than a back-and-forth conversation: a
 *    regret-after-order signal at Bao Bar Micro… moderate weight", and those RANK ABOVE the
 *    new batched-prose episodes for the exact query `confit ask` issues. The same query
 *    against a clean scope returned the real thing: a claim spanning 17 named places, no raw
 *    ids, no single-read framing.
 *  - The personal scope, after M20 — profile A returned `4 episode(s) over 7 fact(s)` and
 *    `personalClaim` picked a PRE-M20 per-confession paraphrase ("a self-aware confession:
 *    the speaker keeps ordering the spicy option to look tough… No further action or
 *    conclusion was developed") over the new episode synthesising four confessions.
 *
 * So the query was never the problem. In both cases the code was right and the scope was
 * polluted, and no amount of prompt or `top_k` work fixes that: the substrate is ranking two
 * eras of ingest against each other and the older era wins on volume.
 *
 * ## Why a new scope rather than a purge
 *
 * The product owner's decision. The alternative was deleting every memory in the old scope,
 * and there is no bulk delete — it is one `DELETE /v1/memories/{id}` per row, over rows that
 * have to be enumerated by search first, which is exactly the enumeration the substrate does
 * not guarantee is complete (`~11/16` retention, non-deterministic ordering). A purge that
 * silently misses rows leaves the pollution in place while reporting success.
 *
 * A generation marker is one constant, auditable at a glance, and abandoning a scope is
 * atomic in a way a purge is not.
 *
 * **The cost, stated rather than discovered:** the old records are still there and still
 * count against storage quota (`GET /v1/usage`). Nothing reads them; nothing can. If quota
 * becomes the binding constraint, a purge is still available later — with the advantage that
 * by then nothing depends on the old scope, so an incomplete purge costs nothing.
 *
 * ## Cutting a new generation
 *
 * Bump `SCOPE_GENERATION`. That is the whole procedure, and it is deliberately one line so
 * that the next person who changes the shape of what is ingested can do it without a plan.
 * Then re-seed: `confit pass seed` refills the pool, and confessions accumulate on their own.
 *
 * Do NOT bump it for a change that does not alter what an episode is synthesised FROM.
 * A different `top_k`, a reworded query, a new degrade flag: none of those need a generation,
 * and each bump abandons real induction material.
 */

/**
 * Bumped when the shape of what is ingested changes, abandoning the previous scopes.
 *
 * `v2` is the first generation to carry a marker at all: the unmarked `confit:pool` and bare
 * `<profile>` scopes hold the pre-M12/pre-M20 eras this exists to escape.
 */
export const SCOPE_GENERATION = 'v2';

/**
 * The collective pool — one scope shared by every diner, holding prose renderings of reads.
 *
 * Referenced by name in `forget` and in every guard that counts pool rows, so it stays a
 * constant rather than being assembled at each call site.
 */
export const POOL_SCOPE = `confit:pool:${SCOPE_GENERATION}`;

/**
 * One diner's own confessions.
 *
 * The profile id used to BE the scope (`A`, `B`), which is why the personal scope had no way
 * to escape its own history. It is now a namespaced, generation-marked key — and note that
 * this touches XTrace only: the DECLARED settings a profile owns live on the relay under
 * D-8's keys and are not affected by a generation bump, which is what makes bumping cheap.
 */
export function personalScope(profile: string): string {
  return `confit:user:${SCOPE_GENERATION}:${profile}`;
}
