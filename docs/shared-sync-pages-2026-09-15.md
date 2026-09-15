# Shared DataSync pages and order transfer reduction

## Problem and evidence

Production order reads repeatedly took 34-55 seconds while client requests timed out at 8 seconds. Retried requests continued alongside the original server work. Multiple other handlers, including status, sharing registration and station heartbeats, also exceeded 8 seconds. At 06:39 UTC the dyno still had a 1024 MB quota and no swap, so available RAM alone did not resolve the delays.

A read-only comparison from a separate local MongoDB client on September 15 returned 134 orders. MongoDB explain reported 0 ms execution time (millisecond resolution), examining 134 documents through the _id index. This does not measure all server-side admission, throttling or network delays. The complete unprojected read took 44.31 and 35.05 seconds in two trials. A database-side projection reduced decoded BSON from 3,396,444 to 1,060,508 bytes; corresponding reads took 10.98 and 22.77 seconds. Response equivalence assertions passed in both trials; response JSON remained 1,033,854 bytes. Local preparation took approximately 3-5 ms.

Requesting zlib compression did not materially improve another comparison (34.52 seconds raw, 10.98 seconds projected). Compression was not added to production configuration.

The user confirmed MongoDB Atlas Free tier. Atlas documents a rolling seven-day limit of 10 GB outbound and throttling after exceeding it. The observed slow large replies and delayed unrelated operations are consistent with throttling, but the account's transfer/operation metrics have not yet confirmed which limit was reached. See [Atlas Free limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/). Moving the application host alone would retain these database limits.

## Change

- Project productionLogs and non-list buyer fields out inside MongoDB, before transfer and BSON decoding. Preserve all other order fields and the existing response projection.
- Share snapshot and delta pages between sockets in one server process. Identical in-flight requests await the same promise; completed requests reuse the same page object.
- Include dataset, scope, timezone, generation, current captured head and request cursors/page key in the cache key. A new captured head selects new data even for a caller with an older baseline. Snapshot and delta keys are separate.
- Every caller independently validates current capture health, scope, generation and retention before reading, and validates scope/generation/retention again before returning. Shared pages do not bypass protocol validation.
- Bound preparation to two concurrent builds and 64 pending distinct keys. Excess distinct work returns UNAVAILABLE. Bound retained pages to 128 entries and 16 MiB of encoded JSON with LRU eviction. These are storage accounting limits, not exact heap/RSS limits.
- Pages remain reusable while their version key remains current; no periodic expiration forces unchanged data to be downloaded again. Old versions are bounded by the entry/byte limits. Failed builds are removed so retries can recover.
- Log aggregate cache builds, joins, hits, active work and encoded-byte occupancy every 30 seconds. Log no record data.

This is a shared page cache populated on demand. It does not preload historical records, copy the whole cache per client, or remove per-client socket serialization costs. A cold read may still exceed the current client timeout while the database transfer path is slow. Retries now join the same work and can consume its cached completion.

## Verification

The integration test submits 25 simultaneous snapshots against a disposable MongoDB replica set and requires one actual order aggregate. It then submits 25 matching delta requests and requires one additional aggregate, checks updates invalidate the current page, and checks excluded fields never reach Node. Unit tests cover a late retry joining the same build, reference sharing, bounded concurrent/distinct work, retry after failure, and byte/count/expiry eviction.

Run with a disposable localhost replica set:

    DATA_SYNC_TEST_URI=mongodb://127.0.0.1:27163/data_sync_test_cache?replicaSet=syncCache node --test test/syncPageCache.test.js test/dataSync.test.js

The full suite also covers scope rollover, retention, collection replacement, change-stream recovery, transport/client reconnects, BOL dependencies, response size limits and bulk changes. Production validation must separately check cache hit/join counts, active order reads, duration, memory trend and real client recovery. Do not infer production resolution from these local correctness checks alone.

## Separate timeout finding

The supplied client log also includes tool:fetch. The current client production/tool store emits that event, but the current server event directory registers no matching handler. This is a separate client/server contract gap and cannot be diagnosed as slow database execution merely from its timeout message.
