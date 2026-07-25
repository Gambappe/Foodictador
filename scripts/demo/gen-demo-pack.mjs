/**
 * The demo pack — extra data so the showcases have something to show (DEMO.2).
 *
 * ## Why the base seed is not enough
 *
 * `data/seeds/reads.json` is 220 reads, PRNG-tuned so `pass neartie` holds. It is NOT
 * regenerated here and must not be: its whole value is that the near-tie invariant is
 * provably satisfied for the scripted beat, and re-rolling it re-rolls that guarantee.
 *
 * What it is thin on is the drivers a diner can actually MATCH. Counted:
 *
 *   matchable    spice_tolerance_low 7 · budget_ceiling 6 · solo_comfort 7
 *                portion_small 5 · gi_constraint 5              = 30 reads
 *   unmatchable  companion_constraint 32 · emotional_exclusion 32 · acclaim_skeptic 32
 *                crowd_aversion 32 · sensory_shift 31 · allergy_constraint 31 = 190 reads
 *
 * So 86% of the corpus sits on drivers no `UsualProfile` can evidence (D-5), and the five
 * that matter clear the k>=5 floor by one or two reads. That is why a card's citation reads
 * "5 of them" and why the score landscape is flat enough that eight places tie exactly.
 *
 * This pack adds depth to those five and spreads it across cuisines, so a demo can show a
 * cohort that sounds like a crowd rather than a quorum, and so affinity has somewhere to move
 * a place TO.
 *
 * ## Deterministic
 *
 * Same PRNG discipline as the base seed: one fixed constant, no clock, no randomness the
 * next run cannot reproduce. A demo that generated different data each rehearsal would be
 * rehearsing something other than the demo.
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = join(ROOT, 'data/demo/pack.json');

/** Same generator the seed uses — reproducible without importing TypeScript. */
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const PACK_SEED = 0xdec0de;

const corpusRaw = JSON.parse(readFileSync(join(ROOT, 'data/places.json'), 'utf8'));
const CORPUS = Array.isArray(corpusRaw) ? corpusRaw : corpusRaw.places;

/**
 * The five drivers a `UsualProfile` can evidence, and how deep to take each.
 *
 * Uneven on purpose. A demo where every cohort is the same size looks generated; these are
 * chosen so one driver is emphatic (spice, 34), two are comfortable, and one sits just over
 * the floor (gi_constraint, 8) so the floor is still visibly doing work on stage.
 */
const DEPTH = {
  spice_tolerance_low: 34,
  budget_ceiling: 26,
  solo_comfort: 22,
  portion_small: 16,
  gi_constraint: 8,
};

/** Signals that read as a REASON when rendered to prose, which is what induction needs. */
const SIGNALS = [
  'pretends_preference',
  'regret_after_order',
  'returns_despite_incident',
  'secret_default',
  'wanted_something_else',
  'trusted_safe_place',
  'never_ordered_again',
];
const CADENCES = ['rarely', 'monthly', 'weekly', 'daily'];

const rand = mulberry32(PACK_SEED);
const pick = (xs) => xs[Math.floor(rand() * xs.length) % xs.length];

/**
 * Reads spread across the whole corpus rather than clustered.
 *
 * Clustered reads produce a cohort that is really one restaurant's regulars, and a citation
 * built on that says "8 people like you" about 8 people who like one place. Spreading keeps
 * the claim about the DRIVER, which is what the citation actually asserts.
 */
const reads = [];
let n = 0;
for (const [driver, depth] of Object.entries(DEPTH)) {
  for (let i = 0; i < depth; i++) {
    const place = CORPUS[(i * 7 + Object.keys(DEPTH).indexOf(driver) * 3) % CORPUS.length];
    n += 1;
    reads.push({
      // A distinct id space from the base seed, so a pack load can never collide with it and
      // `pass census` can attribute a surprise to whichever set produced it.
      read_id: `dec0de${String(n).padStart(2, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`,
      place: place.id,
      signal: pick(SIGNALS),
      driver,
      cadence: pick(CADENCES),
      weight: Math.round((0.55 + rand() * 0.4) * 100) / 100,
    });
  }
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      generatedFrom: `prng ${PACK_SEED}`,
      note: 'Layered ON TOP of data/seeds/reads.json, which is tuned for pass neartie and is not regenerated here.',
      depth: DEPTH,
      reads,
    },
    null,
    2,
  )}\n`,
);

const byDriver = {};
for (const r of reads) byDriver[r.driver] = (byDriver[r.driver] ?? 0) + 1;
const cuisines = new Set(reads.map((r) => CORPUS.find((p) => p.id === r.place).cuisine));
console.log(`demo pack: ${reads.length} reads across ${cuisines.size} cuisines`);
for (const [d, k] of Object.entries(byDriver)) console.log(`  ${d.padEnd(22)} +${k}`);
console.log(`wrote ${OUT}`);
