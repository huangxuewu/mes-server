# Station live assistance

Open a station screenshot, then select the text **Live** control in the lightbox. The lower-left tools provide a focus pointer, pencil, clear screen, and two-way messaging. Stop Live or close the lightbox to end the session and return to the stored screenshot.

Live mode streams full-display JPEG frames through the existing authorized Socket.IO connection. Updated viewers request one frame at a time with at least 500 ms between completed frames (at most two frames per second, depending on capture speed and network latency). Idle polling backs off to two seconds; large images extend the delay to target no more than 512 KiB/s of sustained image payload per network leg, excluding initial bursts and protocol overhead. Updated station clients encode Live at a maximum 1600 pixels on the longest edge with JPEG quality 65. The stored screenshot defaults remain 1920 pixels and JPEG quality 80. Both paths preserve aspect ratio and reject images larger than 5 MB. Live frames and chat are transient and never uploaded to Dropbox. Existing scheduled screenshots pause while live assistance is active; a pending screenshot prevents overlapping Live startup.

Frame protocol 2 is negotiated by the viewer and station. The backend includes the previously validated JPEG revision in capture requests. An updated station hashes its captured JPEG and returns only the matching revision when unchanged, avoiding image transfer through IPC and both network legs. The viewer keeps its existing image URL. A changed image is validated and published with a new revision. Permission, identity, and privacy checks still run before and after every response, including unchanged responses. No full frame is retained by the server for Live.

Hiding or minimizing the operator viewer stops Live and releases its image. Returning to the viewer requires explicitly selecting Live again. A screen change following idle can take up to two seconds plus capture and network latency to appear. This mode is designed for desktop assistance; it is not a high-frame-rate video feed.

The display containing MES at session start remains the capture target even if MES moves or is minimized. Pointer and pencil coordinates are normalized against the displayed image, then mapped to that display's bounds on the station. A transparent, always-on-top, click-through Electron window displays the active-assistance notice, animated focus circles, and drawings. Display removal, rotation, or a bounds change ends the session so coordinates cannot target the wrong screen.

Messaging opens a separate Electron window near the bottom-right of the station display. Both participants can send text. Turning messaging off or ending assistance disables remote replies and displays an ended notice with a Close option. The station window stays open until the station user closes it. Ending Live also displays an ended notice if a chat window was not already open. Closing the operator lightbox does not close the remote chat window.

## Access and session lifecycle

Saved screenshots now choose WebP or JPEG on the station; see [station screenshots](station-screenshots.md) for the codec benchmark and storage behavior. Live retains native JPEG encoding to avoid the additional WebP encode cost on each frame.

- Live mode requires `configuration.page.access`, a connected client reporting `liveSupported`, and enabled station screenshots. Stations whose access status is Disabled cannot stream.
- Each station and each viewer connection can have one live session. Sessions bind to the current linked station connection, station identity, screenshot privacy generation, and operator authentication generation.
- Operators cannot live-view their own station. Both the lightbox and backend check the local station record and identity, including separate connections from that station. Rebinding a viewer to the target station ends its live session and invalidates pending frames.
- The backend checks permissions and identity before and after frame capture and commands. Privacy changes, identity replacement, sign-out, disconnects, and session expiry end the session and invalidate pending responses.
- The station bridge independently checks its local identity and privacy generation before and after Electron operations. The native process and backend expire abandoned sessions after 30 seconds without frame commands/requests, allowing bounded capture time and bandwidth pacing. Explicit stop, privacy changes, and disconnects do not wait for this lease.
- Annotation coordinates, message lengths, command rates, total drawing points, and chat counts are bounded. New windows have isolated, sandboxed preloads exposing only the required chat APIs; arbitrary navigation and additional windows are blocked.
- Live assistance provides visual annotations and text chat. It does not inject operating-system mouse clicks or keyboard input and does not capture microphone audio.

## Deployment and verification

Deploy the backend and update both the viewer and station Electron clients together. Clients without Live capability show that an update is required. Clients with the original Live protocol remain compatible: old viewers receive full frames, and new viewers can suppress repeated frames from older stations at the backend, but uplink suppression and reduced encoding cost require the station update. No new server credentials, Dropbox settings, or streaming service are required.

From `server/`:

```sh
node --test test/stationLive.test.js test/stationConfiguration.test.js test/stationIdentity.test.js test/stationScreenshots.test.js test/stationRelease.test.js test/dropboxConfiguration.test.js
```

From `client/`:

```sh
node --test test/stationLive.test.cjs test/stationLiveWindows.test.cjs test/stationScreenshotPreview.test.cjs test/stationScreenshots.test.cjs test/stationComputer.test.cjs test/stationConfiguration.test.cjs test/stationDeployment.test.cjs
npx --no-install electron-vite build
```

Validation includes native Electron desktop capture, sandboxed overlay/chat pages, main/preload chat round trips, and ended-window retention on Windows. Browser checks exercise the actual lightbox and live composable with synthetic desktop frames, pointer/drawing/clear commands, two-way chat, and stopping/reopening. Automated tests cover privacy races, authorization, connection replacement, frame limits/timeouts, source-display mapping, and session cleanup. Physical multi-monitor hardware and production WAN latency are not available in the local verification environment.
