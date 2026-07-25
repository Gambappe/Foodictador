# Gate zero results — the D-7 protocol (G7)

**Status: PASS**

Run at: 2026-07-25T18:14:25.905Z

The P0.5 protocol is void (DAG §4 D-3 as amended by D-7): nothing drops any more, and
"retrievable from XTrace" is the round-trip the first live contact disproved. The three
questions that block build day now:

1. **The relay survives a kill losing nothing** — SIGKILL, not SIGTERM: every
   acknowledged mutation (reads, job annotations, the M10 ledger) must be present and
   byte-identical after a crash and restart, and the restored store must still mutate.
   Runs anywhere: `npm run gate0` spawns its own relay on a scratch snapshot.
2. **Deletion deletes by handle** — one synthetic line into a scratch scope, handles
   from the succeeded job's `memories_created`, DELETE each, absence sampled across
   repeated searches (the search is non-deterministic, so absence is sampled, and this
   record says so rather than overclaiming).
3. **Induction yields a usable claim** — S5's probe: the exact `confit ask` query
   against the seeded pool, passing only if the claim grounds in at least one seeded
   place name.

Steps 2-3 require `XTRACE_BASE_URL` and `XTRACE_API_KEY`, and step 3 additionally
requires the pool seeded (`confit pass seed`) and settled. A session holding the
credentials clears this by running `npm run gate0` and committing this regenerated
file.

## Results

### relay survives a kill losing nothing — PASS

- seeded 8 entries (jobs, ledger, one idempotent re-put)
- killed with SIGKILL (no graceful path)
- restarted from the snapshot: all 8 entries byte-identical
- post-restart DELETE works — the restored store is live, not a museum

### deletion deletes by handle — PASS

- ingested one synthetic line to a scratch scope (job job_dfb058fe5cb04404b7bbf135998b27ff)
- job complete with 1 memory handle(s)
- deleted 1 handle(s)
- deleted ids absent across 3 search samples (sampled absence — the search is non-deterministic)

### induction yields a usable claim — PASS

- claim: "The conversation worked through a series of examples about people returning to restaurants with mixed feelings, where the surface behavior did not match the real motive. Across places like Miso Hollow…"
- grounded in 6 seeded place name(s): Banh Mi Signal, Chaat Corner, Miso Hollow, Saffron Step, Sardine Social
