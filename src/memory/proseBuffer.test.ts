import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { BATCH_SIZE, createProseBuffer } from './proseBuffer.js';

function buffer() {
  const path = mkdtempSync(join(tmpdir(), 'confit-prose-'));
  return { path, buf: createProseBuffer({ path }) };
}

/** Every file under the buffer root, at any depth — used to prove text does not linger. */
function allFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, name.name);
      if (name.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(root);
  return out;
}

describe('the confession buffer (M20)', () => {
  it('holds until the threshold, then hands back the whole batch', () => {
    const { buf } = buffer();
    for (let i = 1; i < BATCH_SIZE; i++) {
      expect(buf.append('A', `t${String(i)}`)).toBeNull();
      expect(buf.pending('A')).toBe(i);
    }
    const flush = buf.append('A', 'last');
    expect(flush?.texts).toHaveLength(BATCH_SIZE);
    expect(buf.pending('A')).toBe(0);
  });

  it('sends the batch in the order it was confessed — a conversation is ordered', () => {
    // The batch becomes ONE conversation, and a conversation whose turns are shuffled is a
    // different conversation. Nothing about a directory listing guarantees this, so the entry
    // names carry a sortable prefix and this pins it.
    const { buf } = buffer();
    const texts = Array.from({ length: BATCH_SIZE }, (_, i) => `confession number ${String(i)}`);
    let flush = null;
    for (const text of texts) flush = buf.append('A', text) ?? flush;
    expect(flush?.texts).toEqual(texts);
  });

  it('keeps profiles apart: one profile reaching the threshold does not flush another', () => {
    const { buf } = buffer();
    for (let i = 0; i < BATCH_SIZE - 1; i++) buf.append('B', `b${String(i)}`);
    for (let i = 0; i < BATCH_SIZE; i++) buf.append('A', `a${String(i)}`);
    // A flushed; B kept every one of its own.
    expect(buf.pending('A')).toBe(0);
    expect(buf.pending('B')).toBe(BATCH_SIZE - 1);
    expect(buf.drain().map((f) => f.profile)).toEqual(['B']);
  });

  it('a profile id cannot escape the buffer directory or collide with a sibling', () => {
    // Profile ids are A/B today. This exists so that staying true is a property of the
    // buffer rather than of every call site: an id is encoded, never used as a path.
    const { path, buf } = buffer();
    buf.append('../escape', 'should not land outside');
    buf.append('A/B', 'should not land in a nested profile');
    expect(buf.pending('../escape')).toBe(1);
    expect(buf.pending('A/B')).toBe(1);
    expect(buf.pending('A')).toBe(0);
    for (const file of allFiles(path)) expect(file.startsWith(path)).toBe(true);
    expect(readdirSync(path).every((name) => !name.includes('.') && !name.includes('/'))).toBe(true);
  });

  it('stores the text byte-identical — [E11] survives buffering', () => {
    const { buf } = buffer();
    const text = '  I ALWAYS get the pho, and honestly?? it\'s fine.  ';
    buf.append('A', text);
    expect(buf.drain()[0]?.texts).toEqual([text]);
  });

  it('survives the process, which is the only reason it touches disk', () => {
    // Every confession arrives in its own CLI process. Batching is impossible without
    // holding text across them, and that is the whole justification for touching disk.
    const { path, buf } = buffer();
    buf.append('A', 'from process one');
    expect(createProseBuffer({ path }).pending('A')).toBe(1);
  });

  it('drain takes everything waiting, whatever the count', () => {
    // The size threshold alone would leave a profile's last few confessions unsent forever.
    const { buf } = buffer();
    buf.append('A', 'a1');
    buf.append('B', 'b1');
    buf.append('B', 'b2');
    const flushes = buf.drain().sort((x, y) => x.profile.localeCompare(y.profile));
    expect(flushes.map((f) => [f.profile, f.texts.length])).toEqual([
      ['A', 1],
      ['B', 2],
    ]);
    expect(buf.drain()).toEqual([]);
  });

  it('gives every batch a distinct conv_id, and survives losing the buffer (SL-47)', () => {
    // Each batch must be its own conversation: XTrace makes one episode per ingest call, and
    // reusing an id across calls was measured NOT to merge them — so a shared id would just
    // make two batches indistinguishable in the substrate.
    //
    // Derived from the claimed batch rather than a counter, because a counter would have to
    // live in the buffer, which D-10 says may vanish — and `confit:prose:A:0` would then come
    // back for a second, unrelated conversation. A FRESH buffer at a FRESH path is exactly
    // that loss, so the ids must still differ across it.
    const first = buffer();
    first.buf.append('A', 'one');
    const idOne = first.buf.drain()[0]?.convId;
    first.buf.append('A', 'two');
    const idTwo = first.buf.drain()[0]?.convId;
    const second = buffer();
    second.buf.append('A', 'three');
    const idThree = second.buf.drain()[0]?.convId;

    expect(idOne).toBeDefined();
    expect(new Set([idOne, idTwo, idThree]).size).toBe(3);
    for (const id of [idOne, idTwo, idThree]) expect(id).toMatch(/^confit:prose:A:/);
  });

  it('a corrupt entry costs ONE confession, not the personal tier (SL-46)', () => {
    // A file that is JSON but the wrong shape used to throw out of pending/append/drain
    // alike, before anything could repair it — so one damaged file took the personal tier
    // offline permanently, with a symptom that looks like an XTrace outage. One confession
    // is D-10's accepted loss; the tier going dark is not.
    const { path, buf } = buffer();
    buf.append('A', 'the good one');
    const dir = join(path, readdirSync(path)[0] ?? '');
    writeFileSync(join(dir, `${'0'.repeat(15)}-0000-shape.json`), '{"nope":true}');
    writeFileSync(join(dir, `${'0'.repeat(15)}-0001-junk.json`), 'not json at all');

    expect(buf.pending('A')).toBe(3);
    const flushes = buf.drain();
    expect(flushes).toHaveLength(1);
    expect(flushes[0]?.texts).toEqual(['the good one']);
    expect(buf.pending('A')).toBe(0);
    expect(() => buf.append('A', 'still working')).not.toThrow();
  });

  it('a missing directory is empty, not an error', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'confit-prose-')), 'never-created');
    const buf = createProseBuffer({ path });
    expect(buf.pending('A')).toBe(0);
    expect(buf.drain()).toEqual([]);
    buf.append('A', 'one'); // creates the directory on the way
    expect(createProseBuffer({ path }).pending('A')).toBe(1);
  });

  it('a foreign file under the buffer root is left alone, not read as a profile', () => {
    const { path, buf } = buffer();
    mkdirSync(join(path, 'not-a-profile-dir'), { recursive: true });
    buf.append('A', 'mine');
    expect(buf.drain().map((f) => f.profile)).toEqual(['A']);
  });

  it('writes no confession text to disk once a batch is drained', () => {
    // The buffer holds the most sensitive text in the product, so it must not accumulate.
    const { path, buf } = buffer();
    buf.append('A', 'something private');
    buf.drain();
    const bytes = allFiles(path).map((f) => readFileSync(f, 'utf8'));
    expect(bytes.join('')).not.toContain('something private');
  });

  it('clears before the caller ingests, so a failed send loses the batch', () => {
    // D-10 sanctions that loss. The alternative — hold until confirmed — is the delivery
    // guarantee this design exists not to build, and it is why there is no retry ledger.
    // Simulated by taking the flush and never sending it, which is what a thrown ingest
    // leaves behind: the text is gone from the buffer and exists only in the returned value.
    const { path, buf } = buffer();
    for (let i = 0; i < BATCH_SIZE; i++) buf.append('A', `t${String(i)}`);
    const failedSend = createProseBuffer({ path });
    expect(failedSend.pending('A')).toBe(0);
    expect(failedSend.drain()).toEqual([]);
  });

  it('batches exactly BATCH_SIZE=4 at a time — 1 is the defect, and 2 is not the fix', () => {
    // Pinned to the VALUE, not to "more than one" (SL-44). `> 1` passed at 2, at 3 and at 20 —
    // including 1's near neighbour and the value this module's own docblock argues against
    // (twenty means a demo never reaches a flush). The constant is the whole task: at 1, M20 is
    // undone with nothing else going red, so the guard has to be exact.
    expect(BATCH_SIZE).toBe(4);
  });
});

/**
 * SL-39 and SL-40 — why concurrent `confess` processes cannot lose or duplicate a confession.
 *
 * The first implementation held every profile's pending texts in ONE json document and
 * rewrote it on each append: an unlocked read-modify-write across processes. **Measured** —
 * six concurrent `confess` runs released through a barrier destroyed three to five of six
 * confessions across four runs, every one of which had printed `held … or on the next sweep`
 * first; and two processes crossing the threshold together POSTed the same three texts twice
 * under one `conv_id`, which puts near-duplicates in a batch and reproduces the
 * per-confession paraphrase M20 exists to remove.
 *
 * Neither is D-10's accepted loss. D-10 sanctions losing the BUFFER — a disk that goes away,
 * a machine that never sweeps again. It does not sanction destroying a confession when
 * nothing failed, and it does not sanction duplicate ingestion at all.
 *
 * These assert the two structural properties that make the race impossible, rather than
 * re-running it: a spawned-process race is slow and, against a correct implementation, proves
 * only that it did not happen to collide. Both go red against the shared-document version.
 */
describe('the confession buffer under concurrency (SL-39, SL-40)', () => {
  it('an append never touches an existing file, so two appends cannot lose each other', () => {
    // The read-modify-write is the defect, and its absence is the fix: a confession is a NEW
    // file at a path no other process can also choose. With one shared document, the second
    // append rewrites what the first wrote — and if both read before either wrote, one is gone.
    const { path, buf } = buffer();
    buf.append('A', 'first');
    const before = allFiles(path).map((f) => [f, readFileSync(f, 'utf8')] as const);
    buf.append('A', 'second');
    const after = new Map(allFiles(path).map((f) => [f, readFileSync(f, 'utf8')]));

    expect(after.size).toBe(before.length + 1);
    for (const [file, content] of before) expect(after.get(file)).toBe(content);
  });

  it('a claimed confession cannot be claimed twice, so nothing is sent twice', () => {
    // Two buffers at one path stand in for two processes crossing the threshold together.
    // The claim is a rename, which is atomic and fails with ENOENT for the loser — so the
    // texts are partitioned between them, never copied into both.
    const { path } = buffer();
    const one = createProseBuffer({ path });
    const two = createProseBuffer({ path });
    // One under the threshold, so `append` never claims and both drains race for the same
    // pending files — which is the interleaving the shared document lost data in.
    const texts = Array.from({ length: BATCH_SIZE - 1 }, (_, i) => `c${String(i)}`);
    for (const text of texts) expect(one.append('A', text)).toBeNull();

    const first = one.drain().flatMap((f) => f.texts);
    const second = two.drain().flatMap((f) => f.texts);
    const all = [...first, ...second];

    expect(all).toHaveLength(new Set(all).size); // no text in both
    expect([...all].sort()).toEqual([...texts].sort()); // and none lost
  });
});
