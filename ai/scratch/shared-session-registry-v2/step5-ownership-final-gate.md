# Step 5 final ownership gate

Verdict: FAIL — 0 Blocker, 1 Major, 0 Minor.
Reviewer run: `5660a796`.

## Major: close during descriptor shutdown can contend with same manager

`#releaseOwnership` checks close intent, then awaits `SessionOwnership.close()`. The ownership objects mark themselves unheld before native/logical descriptors are actually closed. A concurrent same-manager `pi_close` can replace the cached resident as disk-only, take the remote path, and contend on the still-held logical flock, returning `session_in_use` against itself. Existing tests gate before the final intent check, not during descriptor shutdown.

Keep ownership observably local until all descriptors close, or expose/join a resident release promise/releasing state in `#loadSession` and close before remote acquisition. Add a deterministic test pausing between native and logical descriptor closure and invoking close.

Verified closed: late intent before release check, remote-wait lifecycle serialization, double-fsync uncertain revision adoption/divergence, no queue self-wait or release-before-durable-write.
