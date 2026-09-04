# Document Center runtime

MongoDB is the source of truth for article content, metadata, comments, audit-reference badges, and immutable published revisions. Dropbox stores only binary assets and generated publication artifacts.

## Runtime

- Node.js 22 or newer is required by Hocuspocus 4.
- Start the API, Socket.IO, and collaboration endpoint together with `npm start`.
- Collaboration uses the authenticated WebSocket endpoint at `/collaboration`.

## Dropbox

Configure these server environment variables to enable image, thumbnail, attachment, and published DOCX storage:

- `DROPBOX_CLIENT_ID`
- `DROPBOX_CLIENT_SECRET`
- `DROPBOX_REFRESH_TOKEN`

No Dropbox credential is sent through the Document Center client. Without these variables, article editing, collaboration, comments, versions, and local DOCX downloads continue to work; binary uploads remain disabled with a clear error.

## Seed data

The first Document Center request idempotently creates the SMETA and Target reference pages plus the manufacturing policy starter library. System starters are copied into company-owned drafts and are never silently published as company policy.
