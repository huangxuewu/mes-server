# Station live assistance

Open a station screenshot, then select the text **Live** control in the lightbox. The lower-left tools provide a focus pointer, pencil, clear screen, and two-way messaging. Stop Live or close the lightbox to end the session and return to the stored screenshot.

Updated participants prefer a persistent WebRTC desktop video stream. Video is capped at 15 fps, a 1920-pixel longest edge, and 2.5 Mbit/s, with a detail-oriented content hint and resolution-preserving degradation preference. WebRTC adjusts its sending rate to the connection; these are ceilings, not guaranteed quality or throughput. The viewer renders the received MediaStream directly in a video element. No audio is captured.

JPEG polling continues while video negotiates and stops only when video plays. Older viewers, older stations, older servers, unsupported capture, negotiation timeout, disconnected/failed peers, ended tracks, and a stalled receiver use the existing JPEG path. Failure closes the video peer and source tracks before resuming polling in the same assistance session. There is one video attempt per session; a new Live session can retry. The last JPEG revision is retained for fallback, including a final in-flight response, without overwriting video dimensions.

The JPEG fallback requests one frame at a time with at least 500 ms between completed responses. Idle polling backs off to two seconds; large images extend the delay toward a 512 KiB/s payload target per network leg. Updated stations encode fallback frames at 1600 pixels / JPEG 65. Stored screenshots retain their existing settings, including WebP selection when smaller. JPEG responses retain the 5 MB limit and server image validation. Video uses the media bitrate/resolution bounds instead of the JPEG byte limit. Neither Live transport records or uploads frames to Dropbox. Scheduled screenshots pause during assistance; a pending screenshot prevents overlapping startup.

Frame protocol 2 is negotiated by the viewer and station. The backend includes the previously validated JPEG revision in capture requests. An updated station hashes its captured JPEG and returns only the matching revision when unchanged, avoiding image transfer through IPC and both network legs. The viewer keeps its existing image URL. A changed image is validated and published with a new revision. Permission, identity, and privacy checks still run before and after every response, including unchanged responses. No full frame is retained by the server for Live.

Hiding or minimizing the operator viewer stops Live and releases its image. Returning to the viewer requires explicitly selecting Live again. On the JPEG fallback, a screen change following idle can take up to two seconds plus capture and network latency to appear. Video does not use this polling delay.

The selected monitor (or the display containing MES when no monitor was selected) remains the capture target even if MES moves or is minimized. Pointer and pencil coordinates are normalized against the displayed image, then mapped to that display's bounds on the station. A transparent, always-on-top, click-through Electron window displays the active-assistance notice, animated focus circles, and drawings. Display removal, rotation, DPI scale, or a bounds change ends the session so coordinates cannot target the wrong screen.

Messaging opens a separate Electron window near the bottom-right of the station display. Both participants can send text. Turning messaging off or ending assistance disables remote replies and displays an ended notice with a Close option. The station window stays open until the station user closes it. Ending Live also displays an ended notice if a chat window was not already open. Closing the operator lightbox does not close the remote chat window.

## Access and session lifecycle

Saved screenshots now choose WebP or JPEG on the station; see [station screenshots](station-screenshots.md) for the codec benchmark and storage behavior. The compatibility fallback retains native JPEG encoding.

- Live mode requires `configuration.page.access`, a connected client reporting `liveSupported`, and enabled station screenshots. Stations whose access status is Disabled cannot stream.
- Each station and each viewer connection can have one live session. Sessions bind to the current linked station connection, station identity, screenshot privacy generation, and operator authentication generation.
- Operators cannot live-view their own station. Both the lightbox and backend check the local station record and identity, including separate connections from that station. Rebinding a viewer to the target station ends its live session and invalidates pending frames.
- The backend checks permissions and identity before and after frame capture and commands. Privacy changes, identity replacement, sign-out, disconnects, and session expiry end the session and invalidate pending responses.
- The station bridge independently checks its local identity and privacy generation before and after Electron operations. The native process and backend expire abandoned sessions after 30 seconds without frame requests or video heartbeats, allowing bounded capture time and bandwidth pacing. Explicit stop, privacy changes, and disconnects do not wait for this lease.
- Annotation coordinates, message lengths, command rates, total drawing points, and chat counts are bounded. New windows have isolated, sandboxed preloads exposing only the required chat and video-result APIs; arbitrary navigation and additional windows are blocked.
- Live assistance provides visual annotations and text chat. It does not inject operating-system mouse clicks or keyboard input and does not capture microphone audio.

## Deployment and verification

Deploy the backend and update both Electron participants to enable video. Video protocol 1 is returned only when both participants support it. Existing Live clients and servers continue using JPEG polling; no database migration is required.

Video SDP travels through the existing authorized Socket.IO session (`station:live:video`, operations `offer`, `heartbeat`, `stop`). Offers and answers are limited to 64 KiB, bound to the session owner, and revalidated before and after the station reply. Each peer gathers ICE candidates into its SDP with a five-second deadline; source negotiation has a nine-second deadline and the viewer allows eighteen seconds to play before falling back. Five-second heartbeats maintain both leases; the existing one-second server permission sweep and immediate privacy/disconnect events remain active. Three consecutive heartbeat samples without decoded-frame progress trigger fallback. Disconnected peers have a three-second recovery grace period.

The existing sandboxed overlay owns the source stream. It loads bundled content from `mes-live://capture/` in an isolated in-memory Electron partition with narrowly scoped video permission checks. Main selects the source ID and validates source replies against the current overlay/session. Capture never starts outside an authorized session; stopping or destroying the overlay stops its stream. The partition is reused, but there is no idle capture renderer or background recording. Chat and annotations retain their existing authorized command paths.

STUN uses **Integration → Connect & share → STUN servers** (default `stun:stun.l.google.com:19302`). For routed networks requiring a relay, configure **Integration → Station live assistance**: TURN servers (comma-separated `turn:`/`turns:` URLs), username, and password. These are stored as `integration.stationLive.turnUrls`, `integration.stationLive.turnUsername`, and `integration.stationLive.turnCredential`; each new session reads the current database values. These credentials are delivered only after session authorization; use credentials intended for clients. Without a working direct or relay route, Live falls back to JPEG. No TURN service is provisioned by this change. SDP and media are not logged by the implementation.

From `server/`:

```sh
node --test test/stationLive.test.js test/stationConfiguration.test.js test/stationIdentity.test.js test/stationScreenshots.test.js test/stationRelease.test.js test/dropboxConfiguration.test.js
```

From `client/`:

```sh
node --test test/stationLive.test.cjs test/stationLiveWindows.test.cjs test/stationScreenshotPreview.test.cjs test/stationScreenshots.test.cjs test/stationComputer.test.cjs test/stationConfiguration.test.cjs test/stationDeployment.test.cjs
npx --no-install electron-vite build
.\node_modules\.bin\electron.cmd test/stationLiveVideo.electron.cjs
```

Validation includes native Electron desktop capture, sandboxed overlay/chat pages, main/preload chat round trips, and ended-window retention on Windows. Browser checks exercise the actual lightbox and live composable with synthetic desktop frames, pointer/drawing/clear commands, two-way chat, and stopping/reopening. Automated tests cover privacy races, authorization, connection replacement, frame limits/timeouts, source-display mapping, and session cleanup. Physical multi-monitor hardware and production WAN latency are not available in the local verification environment.

## Local video verification, September 9, 2026

The Electron test opens three sequential sessions using real Windows desktop capture and real WebRTC peers on the same machine. It verifies decoded video, selected source geometry, red/blue desktop pixel changes reaching the receiver, source teardown, JPEG fallback, and no accumulated capture windows. It does not save or upload images. The hidden receiver can throttle presentation callbacks, so decoded fps is reported separately from presentation count.

The latest measured run decoded 14–15 fps at 1920 × 800. Six screen changes reached receiver pixels in 176.2–253.6 ms. First video presentation took 745.6–1704.6 ms; JPEG remains available during production negotiation. These are three local sessions without STUN/TURN, not WAN latency, broad performance percentiles, or fleet capacity results. A prior run emitted Windows Graphics Capture warnings while reusing frames; the later pixel-freshness run passed without those warnings. Physical mixed-DPI/multiple-monitor and TURN-only network checks remain deployment checks. Unit tests cover monitor changes, stale negotiation, authorization, fallback, in-flight JPEGs, cropping a decoded video frame, and privacy cleanup.
