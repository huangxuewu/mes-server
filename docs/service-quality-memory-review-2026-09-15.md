# Service quality and memory review — September 15, 2026

## Outcome

The investigation found several independent defects, rather than one universal memory leak. The main repairs now cover PDF resource destruction, repeated database snapshot reads, native screenshot concurrency, and authentication during reconnect. This review adds a rewrite of document-resource cleanup that previously retained entire collections and their text while checking one file.

The latest completed production observation covers **06:59:00–07:14:24 UTC**, release **v155**, with 45 Heroku samples: **234.67–403.89 MB**, no swap, no R14/R15 memory errors, and no H12 request timeouts. The quota was **1024 MB** throughout this window. This establishes recovery under the observed workload; it is not a peak-capacity test or evidence that the former 512 MB tier is sufficient.

The subsequent dependency review reduced the npm production advisory count from 26 to zero and passed 175 tests, including the complete sync replica-set suite. See [the dependency review](dependency-quality-review-2026-09-15.md) for versions, migration details, primary advisory sources and validation scope.

## Focused code review

| Area reviewed | Assessment and action |
| --- | --- |
| `socket/event/utility.js`, PDF dependency lifecycle | Confirmed PDF.js retained loading tasks and decoded buffers. Earlier dependency upgrade and `finally` destruction removed the measured retention while preserving image hashes. The regression checks failure cleanup and repeated real renders. |
| `utils/dataSync.js`, `utils/syncPageCache.js`, `socket/dataSync.js` | Independent client reads and fields discarded only after transfer were the principal measured latency bottleneck. Earlier changes project fields in MongoDB and share versioned pages/in-flight builds, with bounded cache entries, encoded bytes and distinct pending builds. Cursor, scope, generation, retention and per-caller validation remain enforced. Cache limits describe encoded bytes, not total heap. |
| `socket/session.js`, authentication handlers | A protected request could invalidate an in-flight bind by incrementing its generation while already unbound. The earlier fix has a deterministic failing-before/passing-after regression; expiry and permission checks remain. |
| `utils/stationScreenshots.js`, `utils/stationLive.js` | Full native decoding remains necessary for image validation. Nine parallel decodes retained considerably more native memory than sequential work in isolated Heroku experiments. Earlier changes serialize decoding and bound pending inputs. Screenshot restoration coalesces identical downloads; Live sessions have explicit shutdown and expiry handling. |
| `utils/documentResources.js`, document cleanup caller | Poor memory behavior: materialized every document and revision, then retained every text string in a reference set. Rewritten in this change; details below. |
| `utils/documentAccess.js`, `socket/collaboration.js` | Document mutations use a per-document lock and release it through success/error paths. Collaboration checks session and permission generations and destroys reconstructed temporary state where applicable. Preserve those ownership boundaries. |
| `utils/edi/asnMonitor.js`, `utils/edi/invoiceMonitor.js`, `utils/appointmentRefresh.js` | Existing overlap guards, cursor iteration, lease checks and shutdown handling are useful patterns. They do not warrant a broad rewrite based on the current evidence. |
| `utils/messageAttachmentCleanup.js`, `utils/documentLifecycle.js` | Attachment cleanup limits each pass and prevents overlap. Document lifecycle projects its initial query and uses conditional updates, but lacked an overlap guard. A regression reproduced three simultaneous reads after two timer ticks during a stalled pass. This change makes scheduled passes non-overlapping and allows retries after failure. No production overlap was attributed to today's incident. |
| `socket/sharing.js`, `socket/phoneSharing.js`, `utils/dayjs.js` | Sharing/phone state has owner/session and expiry cleanup; timezone refreshes coalesce concurrent reads. No measured leak was established in these paths. |
| `utils/memoryDiagnostics.js`, server startup | Diagnostics use bounded labels and output and record heap, native/external memory and operation concurrency. Overlapping-operation deltas are correlation, not exclusive attribution. Preserve this distinction when interpreting checkpoints. |

This is an architectural review and focused inspection of the incident paths and adjacent services, not a claim that every handler has been exhaustively audited. It does not justify rewriting the whole application or changing unrelated integration behavior.

## Document cleanup rewrite

1. Read the owning document's attachments first. Missing owners and selections with no resource candidates do not scan the corpus.
2. Stream documents and revisions through explicit 32-record cursor batches. Close cursors in `finally`, including read failures.
3. Retain only candidate URLs/storage paths that are actually referenced, instead of retaining all text in all documents.
4. Decode saved collaboration state whether MongoDB returns a Buffer or BSON Binary. The real database integration test exposed that the old direct conversion produced an empty byte array for BSON Binary and failed cleanup.
5. Preserve checks for references in content, forms, revisions, explicit attachments, saved collaboration and live collaboration. Preserve concurrent-edit checks, file ownership/path checks, original-file exclusions and delete-before-metadata ordering. Incomplete or corrupt reference scans fail before deletion.

### Measured result

Fresh Node 24 processes, a synthetic corpus of 5,000 documents with ten unique 1 KiB strings each, no production database or Dropbox calls. Heap is measured after garbage collection at the deletion check, while the cleanup function is still active.

| Implementation | Retained heap growth | RSS at deletion check | Elapsed time |
| --- | ---: | ---: | ---: |
| Before | 52.42 MiB | 230.18 MiB | 544 ms |
| After | 0.09 MiB | 52.78 MiB | 529 ms |

These numbers measure this synthetic function workload, not the web dyno's total memory. The rewrite reduces retained memory; it still must scan the reference corpus and does not claim lower Atlas transfer volume. The current production incident has not been attributed to this cleanup path.

### Validation

- 28 tests passed across resource cleanup, real MongoDB integration, lifecycle, asset registration and file creation.
- The real MongoDB test spans multiple cursor batches and verifies that only the unused file is deleted, while revision, saved-collaboration and live-collaboration references survive.
- Tests cover interrupted document/revision scans, corrupt collaboration state, missing owners, originals, invalid paths, Dropbox failure and absent files.
- The 5,000-document memory regression requires less than 8 MiB retained heap growth and verifies that collections were not materialized.

## Operational limits and follow-up criteria

- Atlas Free is confirmed by the user. Measured order execution was below millisecond resolution while large replies took seconds; the exact Atlas transfer/throttling metric remains unverified. The shared cache reduces repeated traffic but does not increase the database service allowance.
- Keep the current capacity assessment tied to the observed 1 GB dyno and actual workload. Reopen capacity work if memory approaches quota, native memory grows across repeated comparable workloads without settling, or slow/queued reads return.
- The desktop timeout/null-user and IPC fixes are separate client commits. Development Electron needs a full restart to load main-process changes; an installed client needs its normal release delivery.
- A DigitalOcean fallback plan exists in the workspace report. Moving only the Node service would retain the Atlas constraint.
