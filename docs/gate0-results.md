# Gate zero results — the D-7 protocol (G7)

**Status: BLOCKED** — "relay survives a kill losing nothing" PASS; "deletion deletes by handle" awaiting credentials, "induction yields a usable claim" awaiting credentials.

Run at: 2026-07-25T17:21:38.326Z

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

### deletion deletes by handle — BLOCKED

- needs XTRACE_BASE_URL, XTRACE_API_KEY — run `npm run gate0` in a session holding the XTrace credentials

### induction yields a usable claim — BLOCKED

- needs XTRACE_BASE_URL, XTRACE_API_KEY — run `npm run gate0` in a session holding the XTrace credentials
