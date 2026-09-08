# Station Live performance review — 2026-09-08

Follow-up: saved screenshots now select WebP when smaller, with JPEG fallback. Live remains JPEG. The separate [codec measurements](station-screenshots.md#codec-measurements) explain that decision; the Live benchmark below is unchanged.

The principal bottleneck was repeatedly capturing, uploading, decoding, relaying, and rendering a complete desktop JPEG even when the desktop was unchanged. The implemented changes address that waste for the intended use of occasional desktop assistance. Fleet-wide capacity and smooth video performance remain unproven; this review does not certify either.

## Findings and completed changes

| Priority | Finding and impact | Resolution |
| --- | --- | --- |
| P1 | Every poll sent the full JPEG over station → server → viewer, including identical screens. | Negotiated revision suppression happens in Electron before IPC/network transfer. The backend rejects unknown unchanged revisions and rechecks access before returning them. Only the viewer retains the image. |
| P1 | Fixed polling kept capture and network activity high regardless of activity or payload size. | Changed screens use at least 500 ms after each completed frame. Repeats back off to 1,000 then 2,000 ms. Large payloads extend the delay using a 512 KiB/s per-leg target. The backend enforces the next eligible time before issuing another capture. One outstanding frame remains enforced. |
| P1 | Hidden viewers continued consuming station and network resources. | Visibility loss stops the session, revokes the image, discards pending responses, and requires explicit restart. The explanation is localized in all four languages. |
| P2 | Live used the same 1920-pixel / JPEG-80 encoding as retained screenshots. | Updated Live uses 1600 pixels / JPEG-65. Stored screenshots retain their original settings. This reduces pixel count about 31% for a 16:9 display and trades some fine-text fidelity for lower load. |
| P2 | Every JPEG was decoded again; every sweep repeated database reads despite a recent validation. Connection selection allocated arrays and sorted them. | Revisions already validated in the current session skip image decoding. Sweep reads are skipped when a successful validation is less than one second old. Explicit settings changes and pre/post frame checks always validate. Station queries select only required fields; connection selection uses one pass. |
| P2 | Switching the preview target with the same privacy generation could leave the previous stream active. Live could start while a screenshot was already capturing. | Watch the station record and identity as well as generation; terminate on changes. Reject Live startup while a screenshot capture is pending. |

Self-view protection remains enforced by local station identity and backend socket bindings, including separate connections from the same station. The review preserves full-display capture, annotations, two-way chat, privacy controls, image validation, and retained screenshot behavior.

## Reproducible payload evidence

Run `node scripts/station-live-benchmark.js` from `server/`. It exercises the actual service and JPEG validator using synthetic production-table images, simulated station acknowledgements and a 60-second clock. The comparison uses legacy wire behavior (full 1920/JPEG-80 frames every 250 ms) and optimized behavior. Both runs use the current backend safety checks. JPEG fixtures use node-canvas, not Electron's encoder.

| Desktop workload | Legacy image bytes per leg | Optimized image bytes per leg | Reduction | Captures before → after | JPEG decodes before → after |
| --- | ---: | ---: | ---: | ---: | ---: |
| Static | 48,977,280 | 116,278 | 99.76% | 240 → 32 | 240 → 1 |
| Changes every 5 seconds | 50,494,500 | 1,448,179 | 97.13% | 240 → 45 | 240 → 12 |
| Changes every capture | 50,853,960 | 14,601,825 | 71.29% | 240 → 120 | 240 → 120 |

Each image traverses two network legs. These counts exclude control messages, TCP/TLS/WebSocket overhead, retransmissions, capture time, and network latency. They demonstrate payload reduction under defined workloads, not measured WAN utilization. Changing clocks, video, blinking controls, or overlay animations reduce the chance of an unchanged revision. Hashing suppresses transfer after capture/encoding; it does not eliminate that local work. Idle backoff reduces how often the work occurs.

The benchmark's station reads and authorization checks were each 483 → 96 for static screens, 483 → 114 for occasional changes, and 483 → 243 for continuous changes. These are service call counts with fake database responses, not MongoDB latency measurements. Every returned frame still performs authorization and station validation before and after capture.

## Verification performed

- 61 server regression tests and 48 client regression tests passed. Coverage includes unchanged revision validation, legacy compatibility, enforced pacing, redundant sweep avoidance, hidden viewers, stale responses, self-view, privacy changes, identity replacement, permissions, malformed images, timeouts, Dropbox failures, layouts/configuration, deployment, and native overlay/chat lifecycle.
- `npx --no-install electron-vite build` passed without packaging or version changes.
- `npx --no-install electron scripts/check-station-live-capture.cjs` from `client/` passed on the available Windows display. Actual native capture returned 1920×1080 / 144,646 bytes at JPEG-80 and 1600×900 / 83,904 bytes at JPEG-65. Sequential capture times were 1,052.8 ms and 483.3 ms. These are changing desktop samples with possible warmup effects, not a controlled timing comparison. The script saves and transmits no images.
- Native capture was checked on one available physical display. Multi-monitor geometry and minimized-window selection have regression coverage; this review did not rerun physical multi-monitor tests. It did not run an end-to-end production WAN or concurrent fleet load test.

## Remaining product and rollout decisions

1. **Measure concurrency before broad rollout.** The service has a per-station/viewer limit but no fleet-wide admission cap. The payload target allows approximately 4.2 Mbit/s per leg for a demanding session (about 8.4 Mbit/s across both server directions), plus bursts and overhead. Multiple sessions add together. Pilot on representative low-end stations and actual site links; collect concurrent sessions, frame bytes, capture/round-trip p50/p95, timeout rate, server RSS/event-loop delay, and MongoDB query latency. Choose an admission cap from measured capacity rather than treating these synthetic results as a capacity guarantee.
2. **Accept the assistance tradeoff explicitly.** The rate is at most 2 fps and often lower after capture and transport time. After idle, new activity can take two seconds plus capture/network latency to appear. Small text can be softer at 1600/JPEG-65. Annotations and chat retain their own command path. Retained screenshots are still available at their original quality.
3. **Evaluate a video transport if smooth motion or many concurrent viewers becomes required.** Repeated `desktopCapturer.getSources()` still captures source thumbnails; it is not a persistent video encoder. Electron also supports desktop media streams. A WebRTC design would require separate signaling, network traversal, privacy teardown, and operational validation; it is a future architecture decision, not an untested substitution in this patch. [Electron desktop capture documentation](https://www.electronjs.org/docs/latest/api/desktop-capturer).
4. **Keep WebSocket compression off for this pass.** Existing transport already sends binary JPEGs over WebSocket, avoiding base64 overhead. Socket.IO defaults per-message deflate off and documents performance/memory overhead when enabling it. Shrinking and avoiding image payloads is the measured improvement here. [Socket.IO server options](https://socket.io/docs/v4/server-options/#permessagedeflate).
5. **Preserve the remote user's chat ownership.** Ended chat windows intentionally remain open until the station user closes them. Repeated sessions can accumulate windows; consider a user-controlled way to dismiss ended chats if the pilot shows material memory impact. No automatic closing was introduced.

Roll out backend and both Electron participants together to obtain the full benefit. Old Live-capable stations remain usable, but their uplink and capture costs cannot benefit from the new native protocol until updated. No production deployment was performed by this review.
