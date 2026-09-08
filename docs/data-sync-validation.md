# MES cache and synchronization validation — September 7, 2026

**Result: all nine reproduced regressions are fixed.** The final corrective pass ran **495 tests: 495 passed, none failed, skipped, or cancelled**. The client production build passed.

The [correction plan](data-sync-fix-plan.md) is implemented. Regression tests now exercise acknowledged gate commands and explicit dataset resets where those are the corrected contracts; their data-convergence expectations remain intact. Ten additional cases cover subscription retry/activation, stale source lag, scope changes during reads, queued image cancellation, and multi-page history refresh success/failure.

## Results

| Suite | Tests | Passed | Failed |
| --- | ---: | ---: | ---: |
| Client `test/*.test.cjs` | 291 | 291 | 0 |
| Server synchronization integration | 56 | 56 | 0 |
| Other server `test/*.test.js` suites | 147 | 147 | 0 |
| Separate three-node primary failover | 1 | 1 | 0 |
| **Total** | **495** | **495** | **0** |

Totals count each test/subtest reported by Node once in its final suite run. Earlier exploratory runs and isolated reruns are not added again. The build is separate from the test count.

## Passing coverage

| Area | Exercised behavior |
| --- | --- |
| All 21 datasets | Direct inserts, updates, document replacements, hard deletes; recovery returns resulting state and removes deleted records. |
| Offline changes | Two consumers converge after 1,200 mixed bulk operations over multiple journal pages; three seeded client scenarios exercise another 1,440 changes across reconnects and failed pulls. |
| Pagination | Empty datasets and 500/501/1,001-record boundaries; stable snapshot baseline, byte bounds, fixed delta target, repeated IDs, oversized records, edits while loading. |
| Failure isolation | Failed pages preserve usable data; malformed dataset/IDs/removals/cursors/scopes/generations/pagination cannot partially publish; other datasets continue recovering. |
| Reconnection | Fifty connection flaps retain one listener and avoid repeated snapshots; obsolete responses cannot overwrite current state; negotiated connections repair missing hints through periodic status checks. |
| Persistent cache | Encryption, namespace/key isolation, corrupt ciphertext, missing rows, wrong identities, incompatible metadata, aborted writes, competing writes, empty checkpoints, bounded query eviction, and full-checkpoint repair. |
| Combined exchange | Actual server socket handler over real Socket.IO, actual client coordinator source with Vue reactivity, and AES-GCM/IndexedDB test storage; restart hydrates cached rows offline, then transfers only employee deltas and repairs a dropped notification. |
| Calendar boundaries | Offline factory midnight, timecard moves between dates, spring daylight-saving jump, fall repeated hour, midnight after the fall change, and year rollover. |
| Offline punches | Concurrent duplicate command receipts, operation conflicts, invalid/missing cards, captured date, rollback before receipt commit, replay after deletion, permanent failure retention, read-cache failures independent of durable queued punches, and synchronization continuing during image upload. |
| Capture recovery | Restart/resume, duplicate source delivery, retention expiry, journal holes, invalid resume history, collection drop/rename/replacement, fenced transaction rollback and competing consumers. |
| Real process crash | Killed a separate capture process before its 400-record batch completed. Another process acquired the lease; all 400 journal entries were contiguous and records recovered. |
| Replica failover | Forced a primary change in an isolated three-node replica set. Capture resumed with the same generation; the 50 missing records recovered through deltas. |
| Adjacent functionality | Existing message/authentication, production, document, station identity, portal and timecard lifecycle suites in the client/server test directories. |

## Resolved regression cases

| Priority | Failure | Evidence test |
| --- | --- | --- |
| P1 | Continuous caught-up writes cause capture to report unavailable because health requires an empty poll. | `server/test/dataSync.test.js` |
| P1 | Gate assignment reads Pinia before newly created hauler synchronization arrives, losing the acknowledged hauler ID. | `client/test/employeeSync.test.cjs` |
| P1 | An initial status timeout locks the connection into legacy mode and disables periodic recovery from missing notifications. | `client/test/employeeSync.test.cjs` |
| P1 | **New:** dropping/replacing the isolated database removes sync metadata; the running service never reinitializes it and status throws while reading null state. | `server/test/dataSync.test.js` |
| P2 | A four-dataset server causes additional legacy datasets to reload during ordinary status checks. | `client/test/employeeSync.test.cjs` |
| P2 | Background message invalidation replaces loaded history with the newest page; 100 messages become 50. | `client/test/employeeSync.test.cjs` |
| P2 | A timezone change alters daily shipment membership without invalidating its date-only cursor. | `server/test/dataSync.test.js` |
| P2 | **New:** an approver name change advances the user dependency but not timecards; cached `overtime.approvedBy` remains `Before`, while a fresh snapshot returns `After`. | `server/test/dataSync.test.js` |
| P2 | An older queued portrait batch starts after the new portrait finishes and replaces the new URL. | `client/test/imageCache.test.cjs` |

The corrective implementation rebuilds missing metadata, separates capture liveness from source lag, confirms subscriptions explicitly, reprobes uncertain fallback without list reloads, binds daily generations to timezone, and invalidates timecards on relevant approver changes. Pinia gate commands consume acknowledgements directly; history refresh and queued portraits preserve the latest valid state. The table identifies the original symptoms; every listed regression now passes. None requires user-facing synchronization prompts or moving domain data out of Pinia.

## Reproduction

Run from the MES workspace root:

```powershell
node --test client/test/*.test.cjs
node .codex-tmp/run-data-sync-tests.cjs
node .codex-tmp/run-edge-server-broad.cjs
node .codex-tmp/edge-replica-failover.cjs
```

The disposable replica-set launchers use the already installed local `.codex-tmp/production-run-test/node_modules/mongodb-memory-server` dependency. They supply guarded local test URIs; the broad server launcher also blocks importing the application database configuration. Application database configuration was not used for test connections.

Build validation, without packaging, version changes, or publishing:

```powershell
cd client
.\node_modules\.bin\electron-vite.cmd build
```

Final evidence files under `.codex-tmp/`:

- `fix-results.json` — machine-readable totals and failing names.
- `fix-client-third.log` — 291 client cases.
- `fix-server-second.log` — 56 sync cases, including the real transport/cache and process-kill checks.
- `fix-server-broad.log` — 147 other server cases.
- `fix-replica-failover.log` — three-node failover result.
- `fix-client-build.log` — successful production compilation.

## Limits of this result

This is a broad automated validation pass, not proof of every possible interleaving. It does not certify a packaged two-Electron-client UI session, Windows safeStorage behavior under OS-account changes, real browser disk-full/power-loss behavior, or a production-scale multi-day soak. IndexedDB faults use fake-indexeddb; cryptography, Socket.IO, MongoDB transactions, process termination, and replica elections execute real implementations.

Offline hydration was verified at the store/cache boundary. It does not establish offline cold-start behavior for the entire application: bootstrap still waits for station resolution before configuring its cache namespace. Transport tests use local sockets and controlled disconnects/timeouts; they do not reproduce every proxy, Wi-Fi, or operating-system sleep condition.

The nine known failures no longer block the implementation. Native packaged-client acceptance and production-scale observation remain rollout work; these automated results do not claim those checks have been performed.

## Final project-level review

Shared business arrays remain in their owning Pinia stores. Background status sweeps no longer force legacy list reads. Mutation acknowledgements are consumed by compound commands without becoming competing array writers. Daily query membership and populated approval fields now participate in cache invalidation. No user-facing sync workflow was added.

Future protocol work should follow measured traffic: narrow global message dependency notifications to relevant topic subscriptions, then refresh affected loaded IDs instead of repeatedly scanning a loaded window. The current window refresh prioritizes correct deletions and preserved pagination using the existing protected endpoints. Gate/yard operations still use separate server commands; making that entire move atomic would be a separate domain change. Retire legacy broadcasts only after older clients have migrated.
