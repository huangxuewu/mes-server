# Peer sharing

Deploy server support before distributing the client. No MongoDB migration is needed.

Signed-in MES clients register ephemeral presence through `sharing:register`. The server derives identity from the existing authenticated socket session. Each computer is a separate endpoint; only current registered endpoints can exchange `sharing:signal` messages. Chat, manifests, decisions, and file bytes travel through WebRTC data channels and are never stored or relayed by this service.

## Configuration

- `SHARING_STUN_URLS`: comma-separated `stun:` or `stuns:` URLs. Default: `stun:stun.l.google.com:19302`. TURN is deliberately unsupported; a failed direct connection is shown to the user.
- `SHARING_GEO_ACCOUNT_ID` and `SHARING_GEO_LICENSE_KEY`: MaxMind GeoLite City web-service credentials. Keep them on the server. The service queries `https://geolite.info/geoip/v2.1/city/{ip}` and caches successful city results for 24 hours and failures for five minutes.
- Without location credentials or a usable lookup result, the interface displays **Unknown region**. Location never gates messaging or transfers. IP location is approximate and VPNs can change it.
- On Heroku (`DYNO` set), the client address is taken from the last address appended to `X-Forwarded-For` by the trusted router. Direct/local deployments ignore forwarded headers. Other proxy deployments must explicitly adapt that trust boundary before enabling geographic lookup; do not trust arbitrary client-provided IPs.

## Discovery and availability

The Electron main process exchanges small UDP multicast packets on `239.255.77.69:45873`, TTL 1, on non-loopback IPv4 interfaces. Allow this port on trusted local networks. There are no firewall changes or elevated commands in the app. Multicast isolation, VPNs and blocked multicast may prevent LAN grouping even when a direct WebRTC connection is possible.

Packets contain a backend-origin hash and an ephemeral discovery token, not names or file information. A peer must report another valid token and be mutually observed to enter the same network group. Tokens rotate every minute, old tokens have a 20-second observation overlap, observations expire after 20 seconds, and presence expires after 45 seconds without registration. This is a proximity hint, not an authorization mechanism.

Presence and signaling currently use the server's existing single-process Socket.IO deployment. Running multiple server processes requires a shared presence service and Socket.IO adapter; that infrastructure is not included here.

## Validation

Run `node --test test/sharing.test.js test/messageSession.test.js test/messageTransport.test.js` from `server/`.

The client includes a two-window Electron integration test with a local signaling server, actual UDP discovery, actual Chromium WebRTC data channels, and real temporary-file writes. See the client's `docs/peer-sharing.md` for its command. Before deployment, verify direct connectivity between representative office networks and configure the geolocation credentials if geographic labels are required.
