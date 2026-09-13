# Peer sharing

Deploy server support before distributing the client. No MongoDB migration is needed.

Signed-in MES clients register ephemeral presence through `sharing:register`. The server derives identity from the existing authenticated socket session. Each computer is a separate endpoint; only current registered endpoints can exchange `sharing:signal` messages. Chat, manifests, decisions, and file bytes travel through WebRTC data channels and are never stored or relayed by this service.

## Configuration

- **System Configuration → Integration → Connect & share → Phone sharing URL** (`integration.sharing.publicUrl`): phone-accessible HTTPS URL ending in `/sharing`, for example `https://your-mes-host.example/sharing`. Saved in the config collection as an active global setting. The server reads the effective database value for every new QR invitation, without a restart or runtime-variable fallback. An empty value disables new invitations; existing invitations keep their original URL and expiry. Use the same server origin that serves `/socket`; credentials, query strings, and fragments are rejected. Deploy the server before distributing the updated desktop client. Saving creates the record if missing; no schema migration is required.

- **Integration → Connect & share → STUN servers** (`integration.sharing.stunUrls`): comma-separated `stun:` or `stuns:` URLs. Default: `stun:stun.l.google.com:19302`. TURN is deliberately unsupported; a failed direct connection is shown to the user.
- Configure IPinfo Lite under **Configuration → Integration → IPinfo Lite Settings**. The API Token saves to the active global `config` record `integration.ipinfo.token`. The server reads it on each sharing heartbeat; token changes bypass the previous lookup cache without a restart or logout.
- The saved IPinfo token is the only credential source; a blank token disables country lookup. The service queries `https://api.ipinfo.io/lite/{ip}` with Bearer authentication, groups peers by country code, and labels regions with country names. Successful results are cached for 24 hours and failures for five minutes. IP address data is powered by [IPinfo](https://ipinfo.io/lite); the sharing footer includes attribution.
- Without location credentials or a usable lookup result, the interface displays **MES**. Location never gates messaging or transfers. IP location is approximate and VPNs can change it.
- On Heroku (`DYNO` set), the client address is taken from the last address appended to `X-Forwarded-For` by the trusted router. Direct/local deployments ignore forwarded headers. Other proxy deployments must explicitly adapt that trust boundary before enabling geographic lookup; do not trust arbitrary client-provided IPs.

## Discovery and availability

The Electron main process exchanges small UDP multicast packets on `239.255.77.69:45873`, TTL 1, on non-loopback IPv4 interfaces. Allow this port on trusted local networks. There are no firewall changes or elevated commands in the app. Multicast isolation, VPNs and blocked multicast may prevent LAN grouping even when a direct WebRTC connection is possible.

Packets contain a backend-origin hash and an ephemeral discovery token, not names or file information. A peer must report another valid token and be mutually observed to enter the same network group. Tokens rotate every minute, old tokens have a 20-second observation overlap, observations expire after 20 seconds, and presence expires after 45 seconds without registration. This is a proximity hint, not an authorization mechanism.

Presence and signaling currently use the server's existing single-process Socket.IO deployment. Running multiple server processes requires a shared presence service and Socket.IO adapter; that infrastructure is not included here.

## Phone uploads

Authenticated desktop peers create or reopen an invitation through `sharing:phone:create` with `{ language }`. The response uses the existing status envelope and includes `id`, `url`, `qr` (PNG data URL), `peerId`, `status`, `createdAt`, `expiresAt`, and `idleExpiresAt`. One invitation/session exists per desktop. `sharing:phone:cancel` with `{ id }` is creator-only and idempotent. `sharing:phone:progress` with `{ id }` is emitted by the desktop after actual writes, at most once per five seconds. `sharing:phone` broadcasts state only to the creator.

The page at `/sharing` reads the invitation from the URL fragment, immediately removes it from browser history, and connects to `/sharing-phone` on the existing `/socket` transport. The namespace accepts a one-time `{ invite, key }` claim, then `{ id, key }` for reconnects from the same live page. The random page key stays in memory. The guest has no app token, login, general MES handlers, roster subscription, chat, or outgoing desktop-file capability. Only its creator receives the guest's roster entry. Guest signaling is limited to the paired desktop; file manifests and bytes remain on direct WebRTC channels.

Unclaimed invitations expire after ten minutes. A successful first claim, real phone interaction, and desktop write progress refresh inactivity, up to ten minutes. Signaling, socket heartbeats, and reconnects do not. The absolute deadline is 24 hours after creation. Expiry is checked on actions and by the existing sharing sweep; clients additionally enforce the provided deadlines. Owner logout, disconnect/session replacement, explicit cancellation, and server restart invalidate access. Ending a link cancels unfinished transfers while preserving completed files.

`POST /sharing/end` accepts `{ id, key }` solely to revoke the page's own session on `pagehide`. This is a best-effort beacon: mobile force-quit may omit it, in which case inactivity expiry applies. Backgrounding and file pickers do not themselves revoke access. Reload/navigation intentionally loses the page credential and ends the session. Data and credentials are not persisted; multi-process deployment still requires shared session state and a Socket.IO adapter.

Physical-device acceptance remains necessary on iOS Safari and Android Chrome over the deployed HTTPS origin, including camera/library/file-picker return, backgrounding, forced close, and restrictive networks. There is no TURN or server-upload fallback.

## Validation

Run `node --test test/phoneSharing.test.js test/ipinfoConfiguration.test.js test/sharing.test.js test/messageSession.test.js test/messageTransport.test.js` from `server/`. Phone tests cover invitation ownership, replay, reconnect, signaling isolation, and exact expiry boundaries. The client `--phone-only` integration check uses the real mobile page, Socket.IO namespace, WebRTC, and desktop file writer.

The client includes a two-window Electron integration test with a local signaling server, actual UDP discovery, actual Chromium WebRTC data channels, and real temporary-file writes. See the client's `docs/peer-sharing.md` for its command. Before deployment, verify direct connectivity between representative office networks and configure the geolocation credentials if geographic labels are required.
