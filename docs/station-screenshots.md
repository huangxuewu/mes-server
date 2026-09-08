# Station screenshots

Deploy the backend and rebuild/update station clients together. Older clients remain usable but show **Client update required** for screen capture. Existing and new stations default to screenshots enabled. Administrators can change **Enable station screenshots** in Stations → Config → General.

The backend requests the display containing MES after a capable station connects and every five minutes thereafter. Manual capture uses the same operation. Updated stations encode saved screenshots as WebP (quality 85), retaining JPEG (quality 80) when it is smaller or WebP encoding fails. Encoding happens on the station before upload. Both formats have a maximum dimension of 1920 pixels and a 5 MB upload limit. Capture runs independently of the configuration page. No image is captured from an offline station. Live continues to use its direct JPEG path.

## Storage

Screenshot storage reads the existing active MES Integration → Dropbox settings (`integration.dropbox.clientId`, `integration.dropbox.clientSecret`, and `integration.dropbox.refreshToken`) directly from the configuration database, just like the existing client uploads. Settings are read for each storage operation, so changes do not require a backend restart. The `DROPBOX_CLIENT_ID`, `DROPBOX_CLIENT_SECRET`, and `DROPBOX_REFRESH_TOKEN` environment variables remain fallbacks for missing settings. The Dropbox application needs file content read/write and metadata access. No public sharing links are created.

The latest file is `/DH MES/station-screenshots/<record-id>/<station-identity>/latest.webp` or `latest.jpg`, matching the actual encoded format. MongoDB stores the detected MIME type, published Dropbox revision, and capture metadata. Legacy metadata without a MIME type is treated as JPEG. Reads request the published revision, so a failed or invalidated upload cannot replace the published preview. The alternate-format file is deleted only after successful publication; a failed deletion is retried on subsequent successful captures. Only the published screenshot is exposed in MES. A disposable `mes-station-screenshots` folder under the backend OS temp directory caches encoded bytes; cache loss is recovered from Dropbox.

The station transfers a lossless PNG and a JPEG fallback locally from Electron main to the isolated preload. The preload encodes WebP using Chromium and returns only the smaller final image to the station socket. If WebP or bitmap processing fails, the same captured JPEG is reused; it does not recapture after a privacy change. Backend validation identifies file contents, rejects malformed/animated/oversized WebP, and fully decodes within bounded dimensions before publication. Install the server's new `sharp` dependency when deploying. Updated backends continue accepting JPEG captures from earlier clients; earlier backends request the original JPEG path from updated stations.

## Codec measurements

`npx --no-install electron scripts/benchmark-station-codecs.cjs` in `client/` compares synthetic 1920×1080 desktop images using Chromium, with five warmed encoding samples per format. WebP-85 reduced bytes relative to JPEG-80 by 28.8% for a table, 38.2% for dense text, and 37.3% for mixed graphics. It reduced bytes relative to PNG by 53.4–69.8%. Encoding was substantially slower (roughly 125–183 ms for WebP versus 19–37 ms for JPEG across two local runs); these timings exclude capture, IPC, PNG decoding and network time. They support WebP for infrequent saved captures, not a claim of faster Live frames. Small-text comparison was visually checked on the synthetic fixture and remained readable, though lossy formats are not pixel-identical to PNG.

`npx --no-install electron scripts/check-station-webp.cjs` verifies the built preload and capture helper with synthetic IPC and writes a synthetic WebP for backend decoder verification. Run the benchmark first to generate its input. No real desktop images or Dropbox data are used by either script.

Disabling screenshots blocks capture and image retrieval, hides previews, and retains the last image and cache. Re-enabling restores the retained image and requests a fresh capture when online. Every explicit privacy-setting save advances a generation; requests from earlier generations cannot publish or deliver images. Released/replaced station identities queue their obsolete Dropbox folders for cleanup, retried once per minute.

## Verification

Run from `server/`:

```sh
node --test test/dropboxConfiguration.test.js test/stationScreenshots.test.js test/stationConfiguration.test.js test/stationIdentity.test.js test/stationRelease.test.js
```

Run from `client/`:

```sh
node --test test/stationScreenshots.test.cjs test/stationConfiguration.test.cjs test/stationDeployment.test.cjs
npx --no-install electron-vite build
```

Storage tests use a simulated Dropbox service, including cache loss and restart recovery. Authentication with the existing saved MES Dropbox settings was verified against Dropbox without uploading files. Native capture was checked on a Windows host with one display; the unit tests cover multiple-display selection and minimized-window bounds. Before deployment, check live Dropbox read/write and capture on a physical multi-monitor station, including with MES minimized or obscured.
