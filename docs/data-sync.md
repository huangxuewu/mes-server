# MES working-set synchronization and persistent cache

The existing startup working set stays loaded in Pinia. A shared coordinator restores complete encrypted read checkpoints, negotiates server heads, and recovers changed records without reloading unrelated lists. History and detail queries retain their existing on-demand endpoints. Cache restoration and synchronization add no badges, routine notifications, or dialogs.

## Deployment and durability

Deploy server support before the client. MongoDB must support change streams and transactions (a replica set or sharded deployment). The database identity needs collection/index creation and read/write permissions for `syncState`, `syncJournalV2`, and `timecardCommand`. Business-document schemas do not need migration.

The expanded consumer uses `syncState._id = application-data-v2` and a separate `syncJournalV2`. Older server processes can finish using their v1 metadata during a rolling deployment without competing for the same source-token journal. Older four-dataset clients still use wire protocol v1; changed generations cause dataset snapshots. Retire old metadata only after the old server processes have stopped. A mixed pool may cause extra dataset resets while clients switch between generations, but cannot silently skip those resets.

One sequential database change-stream consumer captures every writer. A 15-second fenced lease coordinates server processes. Journal insertion, per-dataset sequence advancement, and source checkpoint commit in one transaction. A unique source-token hash deduplicates replay. Other Socket.IO servers observe committed heads every second and notify their own clients. Source-history expiry rotates all generations; collection drop/rename rotates affected generations. Missing sync metadata after database replacement is reinitialized with new generations and a fresh source checkpoint.

Journal entries contain changed IDs, source tokens, sequences, and capture times rather than historical business records. Retention pruning advances the earliest recoverable cursor and removes an ordered prefix transactionally. Cleanup runs every minute in bounded batches; seven days is the minimum retained history, and heavy backlogs may take more cleanup cycles.

## Datasets and membership

The 21 datasets are `employees`, `departments`, `positions`, `timecards`, `orders`, `inbound`, `outbound`, `products`, `finishedGoods`, `rawMaterials`, `accessories`, `tools`, `lines`, `parameters`, `gates`, `yard`, `haulers`, `metasheets`, `tutorials`, `announcements`, and `contacts`.

The server preserves existing app-authenticated list access. User rosters, messages, calendar data, and passcodes retain their protected endpoints and are not exposed as raw sync datasets. No arbitrary MongoDB queries or projections are accepted by sync endpoints.

Scope is `all` except timecards, inbound, outbound, and haulers, which use the current factory business date. Daily cursor generations also bind the factory timezone; clients treat generations as opaque. A timezone change requires a snapshot of the affected daily datasets even when the date string is unchanged. Scope and generation are checked again after each server read. Membership preserves existing operational reads:

- Orders use the existing order list, omit production logs, and preserve the buyer projection.
- Inbound includes active shipments and receipts completed since factory midnight.
- Outbound includes active loads, today's/future pickups, and non-parcel loads missing a BOL. Each journal identity is a parent shipment. A complete filtered load array replaces that parent, so removed child loads cannot linger.
- Haulers and timecards belong to the requested business date. Soft-deleted employees/timecards are excluded. Timecard approvers retain the existing populated projection.

Store-derived daily views exclude yesterday's completed rows even offline. Other working-set records remain usable. Historical-only edits advance scanned cursors without loading history into the operational view.

## Socket protocol

Requests retain `{ status, message?, payload }` callbacks. Client calls retain `[error, payload]` tuples.

- `sync:status { datasets?: [name, ...], negotiate?: true }` returns `protocolVersion: 1`, `workingSetVersion: 2`, server clock/timezone/business date, capture health, dependency revisions, and dataset heads. Each head contains `{ dataset, generation, scope, sequence, retainedAfter }`.
- `sync:subscribe { datasets: [name, ...] }` confirms the datasets accepted by the upgraded client. Use it when status advertises `subscriptionRequired`; retry a failed acknowledgement without downgrading the protocol.
- `sync:snapshot { dataset, scope, baseline?, afterId? }` returns `{ dataset, baseline, upserts, afterId, hasMore }`. The baseline is captured before reading. Stage every page and replay from that baseline before publishing a replacement.
- `sync:pull { dataset, scope, cursor, targetCursor? }` returns `{ dataset, fromCursor, nextCursor, targetCursor, upserts, removes, hasMore }`. Keep the target fixed through all pages. Apply the complete validated page synchronously before advancing the cursor.
- `sync:changed` carries no business records and requests a coalesced status check. Correctness does not depend on receiving the notification.

Pages scan at most 500 journal entries and stay below a 4 MiB JSON budget. IDs are deduplicated per page and read at majority consistency, causally after captured changes. Upserts are complete current records; deleted or out-of-scope IDs become removals. Current records can be newer than the scanned target; replay remains idempotent. This is current-state convergence, not an audit replay.

Errors include `RESET_REQUIRED`, `UNAVAILABLE`, `INVALID_REQUEST`, and `RECORD_TOO_LARGE`. Gaps, retention expiry, generation mismatch, or date changes require a dataset snapshot. An individually oversized record fails explicitly rather than being skipped. A failed request retains existing data and its cursor.

Upgraded clients send `negotiate: true`; status alone does not suppress legacy broadcasts. Their explicit subscription joins the notification and dataset rooms. Existing clients that omit the flag retain activation on status. Legacy full-record broadcasts exclude migrated rooms. An old four-dataset server keeps additional stores on legacy list/event paths. Initial unsupported/timeout fallback is reprobed every 30 seconds without refetching ready legacy lists. Legacy lists reload on initialization, reconnect, or explicit sync requests; once v1 is known, failures cannot silently downgrade it. Rolling back to a completely unsupported server requires restarting that desktop client.

## Pinia and cache ownership

Each domain Pinia store owns its business arrays and normalization. The shared sync Pinia store owns cursors, readiness, connection state, retries, and factory date. Components retain local UI state. Snapshot/pull work is serialized per dataset; obsolete connections, generations, namespaces, and date scopes cannot publish old responses.

Notifications coalesce for 100 ms. Status checks run every 30 seconds and on focus/visibility return. Retries use jitter around 1, 3, 10, 30, and 60 seconds. The global auto-refresh plugin no longer unconditionally reloads employee datasets.

Electron creates a random cache key protected by OS-backed `safeStorage`. The renderer encrypts record bodies with AES-GCM in the separate `mes-working-set` IndexedDB database. Cache identity combines server URI, installation station ID, and resolved station record ID. Checkpoints include schema version, cursor, count, save time, and factory clock context. Secure-key/storage failures silently fall back to memory synchronization. Encryption protects persisted record bodies; it does not replace existing authorization or narrow existing broad employee projections.

Records and their cursor commit in one IndexedDB transaction. Full replacements are persisted only after staged snapshot catch-up. Hydration validates records and cannot overwrite completed network loading. A failed disk write keeps the older coherent checkpoint; the next sync retries a full matching checkpoint before incremental disk persistence resumes. Cache eviction/corruption falls back to online recovery.

Configuration and requested schedule ranges/templates use dependency-revision checkpoints. Their query cache retains at most 32 entries per namespace; eviction removes metadata and records together. Operational checkpoints and pending punch commands are outside that eviction group. Private rosters, calendar results, messages, and passcodes are not persisted by this cache.

Online station resolution still precedes normal bootstrap routing. This change does not introduce completely offline cold-start routing or allow cached credentials to authorize access. After station resolution, cached working sets can hydrate without waiting for list downloads.

Portrait batches load four images concurrently. Desired URLs are registered when enqueued, so obsolete queued work is skipped before it can overwrite a newer portrait. The image cache keys requests by ID and URL, ignores obsolete URL completions, and evicts deleted/removed portraits. Incoming data synchronization never waits for portrait or punch-image uploads.

## Dependencies and punch commands

The durable consumer also watches work schedules/templates, configuration, users, calendar events/tasks, topics/messages, and passcodes. Writes rotate opaque dependency revisions with the source checkpoint. Their owning stores refresh only requested/authorized data when the revision changes. Periodic status repairs missed notifications. Configuration status also fingerprints currently effective document IDs, detecting scheduled activation/expiry without requiring a new database edit. Changes to a referenced approver display name/username, replacement, or deletion rotate only the current timecard generation; unrelated user-field edits do not. A bounded dataset reset avoids an unbounded fan-out transaction for populated approval fields. Background topic/message refresh stages the already loaded window through its oldest boundary, retains pagination, reconciles deletions, and publishes only after every page succeeds.

Compound gate assignment belongs to the gate Pinia store and passes the acknowledged hauler ID directly to the gate command. It never waits for list synchronization or inserts an unversioned acknowledgement into a synchronized array.

Punches retain their independent queue and operation IDs. A transaction serializes commands per employee and commits the timecard plus a durable `timecardCommand` receipt. Clock-in date uses `capturedAt` in factory time. Retry returns the original receipt even after later deletion; conflicting ID reuse returns `CONFLICT`, missing targets return `NOT_FOUND`, and malformed commands return `INVALID_COMMAND`.

Negotiated clients receive `{ _id, commandId, committed: true, date }`; legacy clients retain the full-timecard acknowledgment when available. The client accepts only a matching receipt or a legacy document containing its processed event ID. Permanent failures retain the existing dead-letter behavior. Command receipts have no read-journal TTL. Read recovery never clears pending commands.

## Verification and operations

`sync:status.capture.available` requires a live lease, recent successful polling, captured source time within the lag allowance, and no capture error. `pollAgeMs` measures consumer liveness separately from `lagMs`, which estimates time behind the captured source wall time (cluster timestamp fallback). The worker samples the database clock to compensate for server-clock differences. Empty polls advance the observed capture time; busy polls remain healthy when caught up, while processing old source events remains unavailable. Neither metric is end-to-end client latency. Logs report capture errors, generation resets, scanned entries, delta counts, and package bytes.

Run `npm run test:data-sync` in client. Run the server suite with a disposable local replica set and `DATA_SYNC_TEST_URI=mongodb://127.0.0.1:<port>/data_sync_test_<name>?replicaSet=<name>`. The URI guard rejects non-local databases; without it integration cases are explicitly skipped. Build with `npx electron-vite build`, avoiding the packaging script's version/publishing steps.

Tests cover disconnected clients, direct/bulk edits/deletion, repeated writes, snapshot overlap, bounded pages, generation/retention recovery, consumer restart/fencing, dates, punch deduplication, operational shipment membership, child-load removal, order projections, and v1/v2 metadata coexistence. Client tests cover encrypted checkpoint transactions, warm hydration, disk failures, obsolete responses, namespace isolation, bounded eviction, legacy fallback, the actual auto-refresh plugin, and portrait races/concurrency.

No production latency improvement is claimed without measurement. Measure station resolution, hydration, first usable view, verification latency, and bytes per dataset separately. If future access rules differ by station/user, add server-issued capability/projection versions and invalidate affected caches as one protocol migration. Keep the established startup working set; avoid turning those required operational datasets into page-by-page fetches.

The final corrective pass and its test evidence are recorded in [data-sync-validation.md](data-sync-validation.md).
