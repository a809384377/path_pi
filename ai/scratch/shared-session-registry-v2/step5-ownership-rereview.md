# Step 5 ownership re-review

Verdict: FAIL — 0 Blocker, 3 Major, 0 Minor.
Reviewer run: `dd54f7b5`.

## Major 1: late close intent can lose ownership

`#runFailDispatch` checks `closeRequested` before terminal publication, but a close can set intent while that publication is pending. Fail-dispatch then releases ownership before queued close cleanup, which fails `ownership_required`. The exit path has the same check-to-release window. Recheck close/cleanup intent immediately before release within the serialized lifecycle decision. Add a deterministic close-during-publication/release test.

## Major 2: remote wait can release ownership under local close

`#reconcileRemoteWait` acquires and exposes a resident session without using the lifecycle queue, while its unconditional `finally` releases ownership. A concurrent same-manager close can queue cleanup, then wait reconciliation releases the descriptors before the closed mutation. Serialize reconciliation/release with lifecycle or keep transient ownership private. Add an overlapping wait-reconcile/close test.

## Major 3: second reconciliation fsync failure still poisons retry

After link/rename succeeds and first directory fsync fails, the store verifies exact final content and retries directory fsync. If that second sync also fails, the operation rejects while the final revision already advanced; manager memory remains stale and later retries conflict forever. Preserve ambiguous-success state so the caller can adopt the exact intended successor while ownership remains held, or otherwise refresh safely. Test both original and reconciliation sync failing for create and update.

## Verified

Original close resurrection guard, lifecycle-tail failure recovery, and shutdown cleanup retry clearing are correct. No queue deadlock was found. Frozen same-UID/network/third-party/orphan/current-last/platform boundaries are not defects.
