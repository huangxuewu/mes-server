# MES performance investigation — September 13, 2026

The investigation found excessive shipment/order queries, repeated timecard calculation and reads, and a background capture worker processing each change in its own transaction. Server fixes are deployed as **v131**; the tested client changes remain local as requested. No production business records were created or approved for testing.

## Release and initial production verification

The user explicitly approved the server deployment. Release v131 deployed commit `0cd6368` at **05:19:57 UTC / 01:19:57 Eastern** on September 13. It was built from an isolated checkout of the previous production commit `b4394267`, excluding unrelated newer commits and pending work. All **76 release-specific server tests** passed on that isolated checkout before deployment. The performance commit and its release ancestry were also integrated into the main local server branch without committing unrelated pending files.

The server reached the up state at 05:20:08 UTC. `/health` returned HTTP 200 in 206 ms from the development machine. During the first five minutes, observed memory peaked at 363.73 MB and settled around **350 MB of the 512 MB quota**, with zero swap and no new R14/R15 or capture lease failures in the retrieved logs. Sync retained fence 150, a valid lease, no error, and approximately 2.5 seconds of heartbeat/source age at 05:25:23 UTC.

No new business-change journal entries appeared during this initial observation window, so there is no post-release production approval or import latency measurement yet. Capture was already caught up just before deployment; historical journal delays and the local burst benchmarks must not be presented as a measured production before/after improvement. The restart can also account for some immediate memory relief. Sustained workload validation remains necessary.

[Heroku runtime metrics](https://devcenter.heroku.com/articles/log-runtime-metrics) were enabled with the deployment to expose memory, swap, and load in logs. A task heartbeat named **MES overnight performance** checks every 30 minutes through **08:00 Eastern on September 13**, stays quiet for unchanged/non-actionable results, and reports regressions or the final morning result. Its read-only scripts are workspace `tmp/performance-production-status.cjs` and `tmp/performance-production-logs.ps1`; snapshots are in `tmp/performance-production-*.json`.

## Findings and changes

### Socket timeout and shipment imports

`Socket timeout (120000ms)` means the client did not receive an acknowledgement within two minutes. The original toast alone does not identify the request. `load:sync` is the strongest match in the inspected toast paths; invoice requests also use this timeout but normally display errors inline. An event name and timestamp from an actual failure are still needed to attribute the original incident conclusively.

The old import fetched every eligible shipment, then checked the related order separately for each shipment. It reread complete order documents even when their buyers were already marked done. A read-only production sample found 686 eligible completed/picked-up shipments referencing 41 orders, whose buyers were already done. This would produce 1,372 redundant order reads.

The initial shipment query scanned 3,190 documents and returned 721 documents, approximately 2.2 MB. Its database execution was only 7 ms. Fetching those records from this development machine was much slower: the default batch hit a diagnostic 20-second network timeout, while bounded batches completed in 26.4 seconds. These transfer measurements are not Heroku-to-database request timings.

The new import filters by incoming PO numbers, normalizes load values before comparison, skips unchanged shipment writes, and updates order completion in one atomic batch. Schema declarations now cover shipment PO/master PO and order buyer PO lookups. A subsequent read-only production check confirmed all three indexes already exist; missing indexes are therefore not an established cause of the current incident. The new targeted query can use the existing PO index. Existing allocation, BOL, parcel, historical-load, and fulfillment-date behavior is covered by integration tests.

The client now uses Socket.IO's acknowledgement timeout support, which cleans up acknowledgement registrations. Timeout messages identify the event and logs include elapsed time without request payloads. The timeout has not been increased.

### Timecard approval

Approval previously wrote the timecard and then recalculated/saved it through a post-update hook. Schedule resolution ran twice, read employee portraits unnecessarily, and performed independent reads sequentially. The reply also reread the request and approving user.

Approval now reuses the document read for conflict checking, calculates totals/hash in the save hook once, and performs one timecard write. Schedule queries use small projections and independent lookups run together. Verdict responses reuse the saved request and authenticated actor.

The approval Pinia store owns fetching, request state, and loading/saving state. Request details and current punches load concurrently, duplicate detail requests are coalesced, and stale selections/session responses are ignored. The component releases its busy state when approval is acknowledged; loading the next record continues separately with decision buttons disabled until its details are ready.

Read-only production measurements at 05:04 UTC found 307 approval requests: the largest was 4,295 bytes and the projected summary list was 104,147 bytes. The approval payload itself does not justify a pagination or response-protocol redesign at this size.

### Background sync and memory pressure

Capture now commits ordered batches of up to 100 events in one transaction, preserving the journal/checkpoint atomicity and fencing rules. Retention cleanup advances one dataset at a time between capture/lease-renewal cycles. Snapshot and delta pages count serialized bytes incrementally instead of reserializing the growing page for every record. The change stream excludes full inserted/replacement documents because capture uses metadata; a test confirms a 500 KB inserted profile produces a capture event smaller than 2 KB and still reaches clients.

Before deployment, production logs showed repeated `LEASE_LOST` errors and Heroku R14 memory quota errors. R14 errors continued through 05:19:45 UTC, immediately before the release. The code fixes reduce unnecessary work and transfer, but the initial observation does not establish that production memory pressure is permanently resolved. No heap profile was captured, so a specific memory leak has not been identified.

## Measured local results

These benchmarks use disposable localhost MongoDB replica sets and production handlers/models with external services isolated. They inject no network delay and are not production latency promises. Server baseline: `4deb00445d9a731086c22d864769dbab3c5fe8b1`.

| Workload | Before | After |
| --- | ---: | ---: |
| First shipment import, 686 shipments / 41 orders | 3,419 ms | 137 ms |
| Same shipment import with no changes | 1,290 ms | 36 ms |
| Shipment import `find` commands | 1,373 | 1 |
| Capture 1,000 changes | 5,990 ms | 390 ms |
| Capture transactions for those changes | 1,000 | 11 |
| Approval median, five independent requests per version | 25 ms | 13 ms |
| Database operations per approval in the fixture | 19 | 11 |
| Timecard writes per approval | 2 | 1 |

Approval fixture users have no permission category; an actual user with a category can require an additional unchanged authorization lookup. The capture timing was measured before the final full-document exclusion; the full final implementation passes the regression run below.

## Validation

- Server: **79 tests passed, zero failed or skipped**, covering capture/resume/fenced takeover, process termination mid-transaction, page boundaries, all subscribed collections, concurrent order completion, imports, and approvals.
- Client: **197 tests passed**, including actual Socket.IO acknowledgement cleanup and approval-store races.
- A rendered Electron approval test passed: approval acknowledgement plus broadcast races, deferred next-record loading, disabled controls, and explicit forced-conflict confirmation.
- The production client build passed using `electron-vite build` directly, without invoking the version-bumping packaging script.
- Approval integration tests verify totals, integrity hashes, audit ownership, permissions, self-approval restrictions, conflicts, partial row rejection, and unchanged records after a failed timecard save.
- Selected diffs pass whitespace checks. Separate client/server patch bundles apply cleanly to the recorded base commits using temporary Git indexes; the user's working indexes were not changed.

The crash-recovery test deliberately kills a process with an open transaction. It allows MongoDB's abandoned-transaction expiry/abort sweep to finish before asserting takeover, which accounts for most of the approximately 134-second server test run.

## Reproduction and release material

Set `DATA_SYNC_TEST_URI` to a disposable localhost replica set with a database name beginning `data_sync_test_`. The fixtures reject non-local URIs and use unique database names. From `server/`:

```powershell
node --test test/dataSync.test.js test/loadSync.test.js test/timecardApproval.test.js test/outboundFollowup.test.js test/orderAddress.test.js
node scripts/benchmark-load-sync.js 4deb00445d9a731086c22d864769dbab3c5fe8b1
node scripts/benchmark-data-sync.js 4deb00445d9a731086c22d864769dbab3c5fe8b1
node scripts/benchmark-timecard-approval.js 4deb00445d9a731086c22d864769dbab3c5fe8b1
```

Workspace `tmp/performance-release-2026-09-13/` contains `server.patch`, `client.patch`, and a manifest listing the exact files/base commits. These include only this performance work; concurrent sales-invoice and other pending changes are outside the bundles. Test logs and benchmark JSON are under workspace `tmp/performance-*`.

## Production follow-through

The server is released and the relevant production indexes are verified. The client update for the approval UI and better timeout diagnostics remains local by explicit agreement. Continue observing normal operator traffic for acknowledgement latency, sync source lag, lease failures, and memory use. Successful local tests and a quiet initial production window are not sufficient to claim recovery under peak workload.

If memory quota errors continue after release, capture memory measurements and a heap profile under a representative workload to distinguish retained objects from legitimate working-set size. A larger dyno may provide immediate headroom, but its cost and effectiveness should be evaluated using those measurements. Raising the two-minute timeout would leave the demonstrated excess work in place.

The optimized approval still saves the timecard and verdict as separate documents, as before. A failure after the timecard write but before the verdict write remains a workflow-recovery limitation; the failed-save test covers failure of the timecard write itself. This performance change does not claim to make those two writes transactional.
