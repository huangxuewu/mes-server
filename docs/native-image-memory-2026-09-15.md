# Native screenshot memory investigation

After shared snapshot reads removed the sustained order backlog, production RSS continued to increase while JavaScript heap stayed low. At 06:46:44 UTC a screenshot decode checkpoint showed +21.75 MiB RSS, +0.04 MiB heap and +5.93 MiB external memory. Other work overlapped, so a separate experiment was required.

## Linux experiment

Ran synthetic 1920x1080 WebP validation in disposable Heroku one-off processes using the deployed dependency versions. These processes did not boot MES, connect to MongoDB, contact clients, or invoke integrations. Each fresh child decoded 180 synthetic images with the existing full-validation function and forced GC between batches. Images were held constant across modes; child baselines were about 64 MiB RSS. RSS includes native allocator behavior and cannot be equated with retained JS objects.

| Mode | Batch concurrency | Settled RSS | Time for 180 validations |
| --- | ---: | ---: | ---: |
| Default allocator/cache | 9 | 347.88 MiB | 1.899 s |
| MALLOC_ARENA_MAX=2 | 9 | 213.85 MiB | 3.619 s |
| Default allocator/cache | 1 | 183.49 MiB | 5.289 s |
| MALLOC_ARENA_MAX=2 | 1 | 167.34 MiB | 6.659 s |

All settled heaps were about 6.37 MiB, external memory 2.41 MiB and ArrayBuffers 0.26 MiB. Another run with nine concurrent validations settled at 395.82 MiB with the default cache and 333.02 MiB with caching disabled. Native retained RSS varied between runs; these are controlled examples rather than total application memory predictions.

Changing MALLOC_ARENA_MAX also changed sharp's automatic per-image thread count from 1 to 8 on this host. Therefore the arena comparison does not isolate allocator configuration alone. No allocator environment or global sharp cache setting was changed in production.

The evidence supports concurrent native decode work as a material memory cost, not an unbounded JavaScript leak. Serial validation roughly halved settled RSS in the paired comparison, trading synthetic batch throughput for lower native memory. Full JPEG/WebP decoding and malformed/truncated/oversized/animated-image rejection remain required.

References: [sharp cache/concurrency](https://sharp.pixelplumbing.com/api-utility/), [sharp memory fragmentation guidance](https://sharp.pixelplumbing.com/performance/).

## Implementation and verification

Queue validateImage calls across saved screenshot captures, restored downloads and Live validation. Execute one native decode at a time, and accept at most 32 active/queued inputs. Reject invalid encoded sizes before queueing and return a retryable message when full. Release each queue slot on either success or failure. Keep existing image validation rules and per-station capture ownership.

The concurrency experiment used sequential calls to the existing validator; the implementation enforces that order for concurrent callers. A deterministic test holds the native decoder while 32 requests arrive and proves only one decode starts, the 33rd request fails promptly, and later validation recovers after an invalid image. Existing screenshot and PDF tests verify full image validation and publication/privacy behavior. Live service tests cover its use of the same validator. Real production latency and memory remain separate validation steps; synthetic throughput is not a promise about live-session frame rate.

Evidence outside the repository: tmp/screenshot-native-probe-heroku.log, tmp/screenshot-arena-probe-heroku.log, tmp/image-validation-final-tests.log, tmp/station-live-validation-tests.log.
