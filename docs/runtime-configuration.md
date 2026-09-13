# Server application settings

Application settings are managed in **System Configuration → Integration** and read from MongoDB. Environment variables no longer override the settings below. Existing integration fields are reused.

| Section | Setting | Database key | Default |
| --- | --- | --- | --- |
| Connect & share | Phone sharing URL | `integration.sharing.publicUrl` | Empty; new phone links disabled |
| Connect & share | STUN servers | `integration.sharing.stunUrls` | `stun:stun.l.google.com:19302` |
| Station live assistance | TURN servers | `integration.stationLive.turnUrls` | Empty |
| Station live assistance | TURN username | `integration.stationLive.turnUsername` | Empty |
| Station live assistance | TURN password | `integration.stationLive.turnCredential` | Empty |
| Gmail | Quota project number | `integration.gmail.quotaProject` | OAuth client ID's project number |
| Gmail | User quota per minute | `integration.gmail.userQuotaLimit` | 6,000; MES uses 80% |
| Gmail | Project quota per minute | `integration.gmail.projectQuotaLimit` | 1,200,000; MES uses 80% |
| Gmail | Pause background sync | `integration.gmail.syncPaused` | Off |
| Gmail | Incremental sync | `integration.gmail.incrementalSync` | On |
| IPinfo | API token | `integration.ipinfo.token` | Empty; country lookup disabled |
| Dropbox | Client ID, secret, refresh token | Existing `integration.dropbox.*` fields | Empty; storage unavailable |
| EDI | API URL, auth token, web URL | Existing `integration.edi.baseUrl`, `authToken`, `webBaseUrl` | Existing MES defaults |
| EDI | Orderful API key | `integration.edi.orderfulApiKey` | Empty |

New connections, phone invitations, and station sessions read current ICE settings; existing sessions retain their connection configuration. Sharing remains direct-only and never receives TURN credentials. The TURN password is readable/editable only with configuration access and is omitted from configuration broadcasts. Gmail reads settings at quota admission and background dispatch; changing quotas preserves reservations and cooldowns. Dropbox uploads and attachment cleanup read the existing saved credentials per operation.

Before deploying this change, copy any application values that exist only in the deployment environment into these fields. Retire older server workers so they cannot continue using environment overrides. Saving creates missing records; no database schema migration is required. Do not copy authentication secrets into these fields.

## Parameters that remain outside MES

`PORT`, `HOST`, `NODE_ENV`, and Heroku's `DYNO` describe process startup and the hosting environment. `JWT_SECRET`, `SESSION_SECRET`, and `SOCKET_APP_TOKEN` establish authentication before a user can access configuration, and remain deployment secrets. The initial database connection also remains part of server bootstrap. Test database URIs and audit-script parameters apply to developer tooling, not the running MES application.
