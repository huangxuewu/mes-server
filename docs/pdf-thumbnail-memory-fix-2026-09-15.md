# PDF thumbnail memory fix — September 15, 2026

## Change

Repeated `pdf:thumbnail` requests retained decoded PDF image buffers after garbage collection. The old `pdf-to-img 5.0.0` / PDF.js `5.4.624` stack retained documents through global page-mapper listeners, and the handler never destroyed the loaded document.

The handler now awaits `doc.destroy()` in `finally`, before replying on success or render failure. `pdf-to-img` is pinned to **6.2.0**, and the lockfile resolves **pdfjs-dist 5.6.205**. Both the dependency upgrade and cleanup are required by the investigation: cleanup on the old PDF.js version still left document transports reachable. The first-page scale, PNG response and socket error contract are preserved.

The Node engine minimum is now **22.13.0** (still below 25). Local checks passed on Node **22.13.0** and **24.19.0**. The previously inspected Heroku build used Node 24.21.0, which satisfies the new range. A development installation running Node 22.11 must upgrade its runtime.

## Validation

- `npm run test:pdf-thumbnail`: five tests passed on each tested Node version. Tests cover awaited cleanup on success, page failure and empty output; loading/cleanup error responses; and the real handler with multipage input, repeated renders, concurrent requests, base64/typed-array inputs, invalid PDFs and recovery after errors.
- The regression test runs 30 sequential image-heavy renders in a separate process with forced GC. It requires retained ArrayBuffer growth below 32 MiB; the old stack retained approximately 195 MiB for that workload. RSS is reported but is not a portable test threshold.
- Existing form-PDF evidence, form-revision export and document-revision export suites: **16 passed, zero failures or skips**.
- A separate 60-render reproduction used the actual patched handler and the original synthetic 1,100,925-byte PDF. Results after settling and forced GC:

| Metric | Original baseline | Patched handler |
| --- | ---: | ---: |
| RSS | 542.20 MiB | 143.42 MiB |
| ArrayBuffers | 406.26 MiB | 7.26 MiB |
| Retained PDFDocumentProxy | 61 | 0 |
| Retained PDFPageProxy | 61 | 0 |
| Retained PDFWorker | 61 | 0 |
| Retained WorkerTransport | 61 | 0 |

The original and patched thumbnails have identical SHA-256: `10ccb2d9bd22e4c4721674312196fd74958c82842dd8d99c1dd17d0b47ea0998`. A strong-root traversal found no retained WorkerTransport in the patched heap. These are synthetic Windows measurements, not a production Linux load test or a guarantee for every document.

## Production status and remaining evidence

The fix is local and has not been deployed by this task. The last checked production release was v149 / `32c4ede7`; the separate query improvements in `0b44e64` also were not deployed at that check. Existing scanned SignPad grants will need rescanning when those query/SignPad changes roll out.

The PDF retention defect is fixed in local validation. Existing production logs cannot establish how many historical spikes came from thumbnail requests. After rollout, compare dyno RSS/swap and thumbnail request frequency/concurrency across a representative workload. Oversized PDFs and concurrent rendering can still consume temporary memory; these tests do not establish safe limits for every input. The investigation did not justify treating session storage or idle watchers as proven causes, so this patch does not change them.

Reference: [pdf-to-img resource management](https://github.com/k-yle/pdf-to-img#resource-management). Local evidence under the parent MES workspace's `tmp/` includes `memory-pdf-fix-tests-node22.log`, `memory-pdf-fix-tests-node24.log`, `memory-pdf-fix-document-tests.log`, `memory-pdf-fixed-current-image.jsonl`, `memory-pdf-fixed-object-counts.json`, and `memory-pdf-fixed-retainer-path.json`.
