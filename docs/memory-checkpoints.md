# Production memory checkpoints

`[Memory]` JSON logs are enabled in production. `MEMORY_DIAGNOSTICS=0` disables them on the next process start; `MEMORY_DIAGNOSTICS=1` enables them locally. No dependency, database schema or business response changes are required.

## What is measured

- Startup, module loading and listening checkpoints, followed by a process sample every 30 seconds.
- RSS, JavaScript heap used, external memory and ArrayBuffer memory, all in MiB. ArrayBuffers are included in external memory: do not add them together. Heroku swap is a separate platform metric.
- Registered inbound socket handlers, including PDF thumbnails and search; HTTP request lifetimes grouped into static API, SignPad and other categories.
- Invoice monitor/queue verification, ASN monitor, Gmail steps, screenshot capture/decoding, data-sync capture polls and dataset reads, document lifecycle, message-attachment cleanup and station-release checks.
- Operation counts, exceptions, concurrent counts, durations and the largest positive process-memory change observed during each operation. `overlap` means another instrumented operation was active during the interval. Nested operations also overlap.

`type: process` shows the current memory, active operations and the 12 operations with the largest positive deltas in the preceding reporting window. `maxDeltaMiB` values are independent maxima across completed calls; they need not come from the same call and are not additive. Operations still running at a sample boundary appear in `activeOperations`; their before/after delta is recorded when they finish. The detailed active list is limited to 20 entries; `active` includes all in-flight work.

`type: operation` includes a before/after snapshot when a metric changes by at least 16 MiB in either direction, or when the wrapped function throws/rejects. The first 20 such records per window are emitted; `suppressedDetails` reports additional records. Handlers that catch errors and reply with an error payload count as completed calls, not thrown exceptions. Socket timing ends when the registered function returns or its returned promise settles; detached callbacks/work are outside that lifetime. HTTP timing ends on response finish or connection close.

Only server-selected operation names, timestamps and numeric counters are recorded. There are no arguments, return values, document bodies, image data, URLs, query strings, user IDs or exception messages in these logs. At most 256 operation labels plus an overflow bucket are retained. Completed-call objects and history are not retained, and the sampling timer is unreferenced.

## Reading a spike

1. Match timestamps and dyno identity against Heroku memory/swap samples and deployment restarts.
2. Compare `heapUsed`, `external` and `arrayBuffers` to identify which memory category grew. RSS can also reflect native allocations and allocator retention.
3. Review the operation records, interval rankings and active-operation list around that increase. Repeated increases with low overlap provide a stronger lead than a single large delta during concurrent work.
4. Confirm the suspected path with an isolated reproduction or a targeted allocation profile before declaring it the cause.

These checkpoints measure **process-wide changes during an operation**, not exclusive bytes allocated by that function or exact retained ownership. Garbage collection, overlapping requests, model change-stream callbacks and uninstrumented native/background work can affect every delta. No forced GC, heap snapshot or public diagnostics endpoint is introduced.

Validation covers wrapper return/error/callback semantics, overlap detection, in-flight samples, bounded storage/logging, registration cleanup and the disabled switch. Run `node --test test/memoryDiagnostics.test.js`; affected workflow/integration tests are also run with `MEMORY_DIAGNOSTICS=1` against disposable localhost databases before deployment.

September 15 validation: 188 tests passed across the affected suites, including the Gmail suite rerun after correcting its configuration-query mock to support the existing `maxTimeMS` API. Data-sync and Gmail integration tests used a disposable localhost replica set; no tests were skipped. A 35-second isolated application run also verified startup/periodic checkpoints, one real socket connection and 44 model watchers without production database access. These checks verify instrumentation behavior, not production memory attribution.
