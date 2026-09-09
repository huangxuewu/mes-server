# Station remote updates

The Stations page compares the reported installed version with the version in the
published `latest.yml` from `huangxuewu/mes-release`. This is the Windows update
channel used by the installer, rather than the rate-limited GitHub release API.
The backend caches successful discovery for one minute and rechecks it when an
operator deploys. A discovery failure retains the last known version for display
but disables deployment until a check succeeds.

The deployment command includes the version shown to the operator. If the latest
release changed before the command is sent, the backend updates the roster and
asks the operator to review it. Stations also verify that the selected feed
returns the requested version before downloading. Only a newer version can be
installed through electron-updater; installation remains silent with relaunch.

## GitHub fallback

Stations first try GitHub. An unreachable feed, failed installer download, or
download with no progress for 30 seconds triggers a retry through the configured
MES backend. The server retry has a two-minute download inactivity limit.

The backend serves:

- `/station-updates/latest/latest.yml` for discovery.
- `/station-updates/<version>/latest.yml` for a specific release.
- `/station-updates/<version>/<installer filename>` for the installer bytes.

The metadata points installer requests back to the MES server. The server follows
GitHub redirects itself and streams the file, so the station does not need to
reach GitHub or its asset hosts. Manifests are cached in memory; installer bytes
are streamed without buffering the whole file or retaining a disk cache. Both
the relay and electron-updater validate the manifest's size and SHA-512. Existing
installer signature verification is retained. Only files named in a validated
MES release manifest are allowed; this is not an arbitrary download proxy.

The Stations page displays the installed and latest versions, progress, and
whether the download is coming from GitHub or the MES server.

## Rollout

Deploy the backend (including `npm ci` for the YAML parser), then publish and
install the updated Windows client. The backend must reach GitHub, and stations
must reach the backend. Local build numbers do not become available remotely
until their release and `latest.yml` are published.

Older clients cannot use the new fallback automatically. For a station that is
already unable to reach GitHub, obtain the installer filename from
`/station-updates/latest/latest.yml` on the deployed backend and download its
relative installer URL through that backend for the first installation. Later
remote deployments can switch to the relay automatically.
