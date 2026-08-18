# Research: Safe per-session cross-process ownership

## Summary

Use a **kernel-held, non-blocking exclusive `flock(2)` on one persistent file per session**, held for the entire Pi subprocess lifetime. This is the smallest mechanism that provides automatic release after normal exit, crash, or reboot without stale-reclamation races; it requires a small native/prebuilt binding because Node.js core does not expose `flock`.

If native code is absolutely prohibited, there is no equally safe crash-reclaiming solution using only Node pathname operations. Prefer a fail-sticky atomic lockfile with manual reclamation—or, if an embedded database is acceptable and Node 24.15+ is available, hold a SQLite write transaction.

## Findings

1. **Recommendation: persistent file plus kernel lock** — Use `~/.pi/agent-mcp/locks/<sha256(session-id)>.lock`, opened once and locked with `LOCK_EX | LOCK_NB`. Keep its file descriptor open until Pi exits; close it to release. `flock` locks belong to the open file description and disappear when all referencing descriptors close, including process termination. [Linux `flock(2)`](https://man7.org/linux/man-pages/man2/flock.2.html)

2. **Critical: never unlink the lock file during normal release or startup cleanup** — Unlinking permits one process to retain a lock on the old inode while another creates and locks a new inode at the same pathname, causing split-brain. Leave the small file permanently and release only by unlocking/closing the descriptor. The file content is diagnostic, not authoritative.

3. **Acquisition algorithm**:
   1. Create `~/.pi/agent-mcp/locks` once with mode `0700`.
   2. Derive a fixed filename from a domain-separated SHA-256 of the exact session identity; do not place raw session IDs in paths.
   3. Open the persistent lock file with `O_CREAT | O_RDWR`, mode `0600`; reject non-regular files and keep the containing directory private.
   4. Call non-blocking `flock(fd, LOCK_EX | LOCK_NB)`.
   5. On `EWOULDBLOCK`/`EAGAIN`, return **busy** without inspecting timestamps, PID files, or deleting anything.
   6. Once locked, truncate/write diagnostics such as `{pid, sessionHash, acquiredAt, randomToken}`. A crash before or during this write is harmless because ownership is the kernel lock.
   7. Spawn/resume Pi only after lock success. Retain both the descriptor and binding object strongly for the full session.
   8. On Pi termination, error, or cancellation, close the descriptor in `finally`. Do not unlink the path.

4. **Crash and restart need no reclamation algorithm** — Kernel locks are released when the owning open file description is closed. Process death and machine restart therefore leave only an unlocked diagnostic file, which the next process can lock immediately. There is no heartbeat timeout and no false takeover caused by event-loop stalls. [Linux `flock(2)`](https://man7.org/linux/man-pages/man2/flock.2.html)

5. **Atomic `mkdir`/`open('wx')` is safe only for acquisition, not automatic reclamation** — Node documents `'wx'` as exclusive creation that fails with `EEXIST`, and warns against check-then-open races. However, Node has no pathname operation equivalent to “remove only if this pathname still names inode/token X.” Concurrent stale inspectors can delete or rename a newly acquired lock after the old owner releases, producing split-brain. [Node.js filesystem documentation](https://nodejs.org/api/fs.html)

6. **Critical: creator crash between `mkdir` and owner metadata cannot be safely solved with an age timeout** — An empty lock directory may mean either a dead creator or a live creator delayed before writing. Treating it as stale after a timeout can overlap a live owner; treating it as busy is safe but may remain false-busy indefinitely. Prewriting metadata and publishing via a hard link avoids the empty-publication window but still does not provide an atomic compare-and-delete operation for safe reclamation.

7. **PID alone is insufficient because PIDs are reused** — Linux exposes process start time in `/proc/<pid>/stat` field 22, measured since boot, so `{pid,starttime}` is materially safer than PID alone. It is Linux-specific, while macOS needs a different process-introspection mechanism. Permission failures and process disappearance during inspection must produce **busy/unknown**, never reclamation. [Linux `proc_pid_stat(5)`](https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html)

8. **PID plus start fingerprint improves evidence but not the reclamation CAS** — It can establish that the recorded process is gone or that its PID was reused, but another contender may change the pathname between verification and removal. It therefore cannot make a pure Node lockfile safely reclaimable by itself.

9. **Heartbeat leases favor availability over exclusivity** — A paused event loop, suspended laptop, debugger stop, CPU starvation, or delayed filesystem operation can make a live owner appear expired. Reclaiming then creates unsafe split-brain unless the protected Pi operation supports fencing tokens, which it does not. Recent real-world lockfile fixes have increased stale thresholds specifically to reduce false stale detection, illustrating that timing only changes probability rather than safety. [npm CLI lock compromise report](https://github.com/npm/cli/issues/8733)

10. **Safe false-busy is preferable to unsafe split-brain** — For this requirement, ambiguous metadata, permission errors, malformed records, clock anomalies, or failed process inspection must block acquisition. Only kernel ownership—or a transactional compare-and-swap mechanism—can combine automatic crash recovery with strict exclusivity.

11. **Advisory locking is sufficient under cooperative ownership** — `flock` does not prevent unrelated processes from ignoring the lock, but all MCP processes can follow the same protocol. It is local-filesystem appropriate; behavior on NFS/SMB varies and is explicitly outside scope. [Linux `flock(2)`](https://man7.org/linux/man-pages/man2/flock.2.html)

12. **Dependency trade-off** — Node core currently lacks `flock`/`fcntl` APIs, so use a narrowly scoped dependency with macOS/Linux prebuilt binaries and no runtime compilation where possible. Prefer `flock` over process-associated POSIX record locks because its open-file-description lifetime is easier to reason about. Reject startup if the binding cannot load; silently falling back to lease reclamation weakens the safety contract.

13. **SQLite is safe but disproportionately large** — Holding `BEGIN IMMEDIATE` on a dedicated database connection gives single-writer exclusion; another writer gets `SQLITE_BUSY`, and connection close/crash rolls the transaction back. Node’s built-in SQLite became stable in Node 24.15.0, but a long-lived database transaction and version requirement are excessive for one mutex and conflict with the “no database” preference. [SQLite transactions](https://sqlite.org/lang_transaction.html) [Node 24.15 release](https://nodejs.org/en/blog/release/v24.15.0)

14. **Native-free fallback** — If native bindings and SQLite are both prohibited, use `mkdir(<session>.lock)` or `open('wx')`, write immutable owner metadata, remove only on orderly release by the owning process, and require explicit operator cleanup after crashes. This intentionally accepts false-busy rather than implementing unsafe automatic reclamation.

## Mechanism Comparison

| Mechanism | Crash release | PID reuse risk | Reclaim TOCTOU | Split-brain risk | Recommendation |
|---|---:|---:|---:|---:|---|
| `flock` held on persistent inode | Automatic | None | None | Low, if file is never unlinked | **Preferred** |
| Atomic lockfile + PID/start fingerprint | Manual logic | Reduced | Unresolved | High if auto-reclaimed | Only fail-sticky |
| Heartbeat lease | Timeout-based | N/A | Present | High during pauses | Reject |
| `fcntl`/`flock` addon | Automatic | None | None | Low | Prefer `flock` semantics |
| SQLite held transaction | Automatic | None | Transactional | Low | Safe, oversized |
| Plain PID file | Manual logic | High | Present | High | Reject |

## Tests

1. **Mutual exclusion** — Launch 50 child Node processes against one session; assert exactly one acquires and all others return busy.
2. **Session independence** — Acquire locks for 50 distinct session hashes concurrently; assert all succeed.
3. **Orderly release** — Acquire, close normally, then assert immediate reacquisition.
4. **Crash release** — Acquire in a child, send `SIGKILL`, wait for process death, then assert immediate reacquisition without deleting the file.
5. **Machine-restart model** — Precreate arbitrary lock files with stale metadata but no kernel holders; assert acquisition succeeds.
6. **Creator metadata crash** — Kill the holder immediately after successful `flock` but before metadata write; assert the next process acquires.
7. **Descriptor lifetime** — Force garbage collection and asynchronous load while held; assert a contender remains busy, proving the descriptor is retained strongly.
8. **Pi spawn failure** — Inject spawn rejection after acquisition; assert `finally` closes the lock.
9. **Signal handling** — Exercise `SIGINT`, `SIGTERM`, uncaught error, and parent stdio closure; assert the process terminates and the OS releases ownership.
10. **No-unlink invariant** — Assert release leaves the same inode in place; repeatedly acquire/release while contenders run.
11. **Adversarial pathname** — Replace the lock path with a symlink or directory in the private lock directory; assert startup fails closed rather than following or deleting it.
12. **Malformed diagnostics** — Empty, partial, oversized, and invalid JSON contents must not affect lock acquisition decisions.
13. **Binding failure** — Simulate an unavailable native binary; assert a hard startup error rather than fallback to heartbeat or PID reclamation.
14. **Platform CI** — Run the subprocess suite on Linux x64/arm64 and macOS x64/arm64 with supported Node versions.

## Review Findings

- **blocker:** `~/.pi/agent-mcp/locks/<session>.lock` — unlinking a `flock` file during release or stale cleanup permits simultaneous locks on different inodes.
- **blocker:** any heartbeat-based implementation — reclaiming solely because `mtime` exceeded a threshold can resume one Pi session twice.
- **blocker:** any PID-only stale check — PID reuse can classify a live unrelated process or stale owner incorrectly.
- **high:** any PID/start check followed by unconditional `rm`, `rmdir`, or `rename` — the validation and pathname mutation are not one atomic compare-and-swap.
- **high:** silently falling back when the advisory-lock dependency is unavailable — changes the guarantee from strict exclusion to probabilistic exclusion.
- **medium:** owner metadata used as authority — partial writes and diagnostic corruption should never decide ownership when a kernel lock is available.

## Sources

- Kept: [Node.js filesystem documentation](https://nodejs.org/api/fs.html) — primary documentation for exclusive creation, hard links, and unlink behavior.
- Kept: [Linux `flock(2)`](https://man7.org/linux/man-pages/man2/flock.2.html) — primary lock lifetime and advisory-semantics reference.
- Kept: [Linux `proc_pid_stat(5)`](https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html) — primary definition of the Linux process-start fingerprint.
- Kept: [SQLite transactions](https://sqlite.org/lang_transaction.html) — primary transaction acquisition, busy, close, and rollback semantics.
- Kept: [SQLite locking](https://www.sqlite.org/lockingv3.html) — primary crash-recovery and file-locking details.
- Kept: [Node 24.15 release](https://nodejs.org/en/blog/release/v24.15.0) — authoritative built-in SQLite stability/version boundary.
- Dropped: Generic lockfile package documentation — implementation claims do not eliminate the fundamental lease and compare-delete races.
- Dropped: Shell `flock` utility recommendations — macOS does not ship the utility by default, and spawning a helper complicates descriptor lifetime.
- Dropped: Network-filesystem locking guidance — explicitly outside scope.

## Gaps

- The exact native binding should be selected after checking the project’s supported Node ABI matrix, release cadence, provenance, and availability of prebuilt macOS/Linux artifacts.
- macOS kernel semantics should be validated in CI against the selected binding; the recommendation relies on `flock(2)`, not the absent-by-default macOS `flock` command-line utility.
- Advisory locks cannot defend against a malicious or buggy peer that ignores the protocol. This is acceptable only because the cooperating MCP servers are the ownership participants.
