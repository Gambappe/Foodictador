import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { BATCH_SIZE, createProseBuffer } from './proseBuffer.js';

function buffer() {
  const path = join(mkdtempSync(join(tmpdir(), 'confit-prose-')), 'buffer.json');
  return { path, buf: createProseBuffer({ path }) };
}

describe('the confession buffer (M20)', () => {
  it('holds until the threshold, then hands back the whole batch', async () => {
    const { buf } = buffer();
    for (let i = 1; i < BATCH_SIZE; i++) {
      expect(buf.append('A', `t${String(i)}`)).toBeNull();
      expect(buf.pending('A')).toBe(i);
    }
    const flush = buf.append('A', 'last');
    expect(flush?.texts).toHaveLength(BATCH_SIZE);
    expect(buf.pending('A')).toBe(0);
    await Promise.resolve();
  });

  it('keeps profiles apart', () => {
    const { buf } = buffer();
    buf.append('A', 'a1');
    buf.append('B', 'b1');
    expect(buf.pending('A')).toBe(1);
    expect(buf.pending('B')).toBe(1);
    expect(buf.append('A', 'a2')?.texts).toBeUndefined(); // still under the threshold
  });

  it('stores the text byte-identical — [E11] survives buffering', () => {
    const { buf } = buffer();
    const text = '  I ALWAYS get the pho, and honestly?? it\'s fine.  ';
    buf.append('A', text);
    expect(buf.drain()[0]?.texts).toEqual([text]);
  });

  it('survives the process, which is the only reason it is a file', () => {
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

  it('gives every batch a distinct conv_id', () => {
    // Each batch must be its own conversation: XTrace makes one episode per ingest call, and
    // reusing an id across calls was measured NOT to merge them — so a shared id would just
    // make two batches indistinguishable in the substrate.
    const { buf } = buffer();
    buf.append('A', 'one');
    const first = buf.drain()[0]?.convId;
    buf.append('A', 'two');
    const second = buf.drain()[0]?.convId;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);
  });

  it('clears before the caller ingests, so a failed send loses the batch', () => {
    // D-10 sanctions that loss. The alternative — hold until confirmed — is the delivery
    // guarantee this design exists not to build, and it is why there is no retry ledger here.
    const { buf } = buffer();
    for (let i = 0; i < BATCH_SIZE; i++) buf.append('A', `t${String(i)}`);
    expect(buf.pending('A')).toBe(0);
  });

  it('a corrupt file reads as empty rather than failing confess', () => {
    // Also D-10: losing the buffer is accepted, and refusing to start over a damaged one
    // would turn an accepted loss into a broken command.
    const { path, buf } = buffer();
    buf.append('A', 'one');
    writeFileSync(path, 'not json at all');
    const revived = createProseBuffer({ path });
    expect(revived.pending('A')).toBe(0);
    expect(() => revived.append('A', 'two')).not.toThrow();
    expect(revived.pending('A')).toBe(1);
  });

  it('a missing file is empty, not an error', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'confit-prose-')), 'nested', 'never-written.json');
    const buf = createProseBuffer({ path });
    expect(buf.pending('A')).toBe(0);
    expect(buf.drain()).toEqual([]);
    buf.append('A', 'one'); // creates the directory on the way
    expect(createProseBuffer({ path }).pending('A')).toBe(1);
  });

  it('writes no confession text to disk once a batch is drained', () => {
    // The buffer holds the most sensitive text in the product, so it must not accumulate.
    const { path, buf } = buffer();
    buf.append('A', 'something private');
    buf.drain();
    expect(readFileSync(path, 'utf8')).not.toContain('something private');
  });

  it('batches four at a time — not one, which is the defect it exists for', () => {
    // Pinned deliberately. One-at-a-time ingests were measured producing one episode per
    // confession (8 confessions, 8 episodes, 8 conv_ids), which is what M20 fixes. If this
    // constant drifts back to 1 the whole task is undone with nothing else going red.
    expect(BATCH_SIZE).toBeGreaterThan(1);
  });
});
