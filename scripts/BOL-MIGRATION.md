# Shared BOL migration

Shipments store an optional `bolId`. A load with BOL data has one `bolDocument`; an unassigned shipment with BOL data has its own document. Missing historical BOL data remains an empty reference and creates no placeholder document.

List APIs provide `bolSummary` without the draft. The desktop fetches the full document through `bol-document:get` and saves through `bol-document:save`. Old embedded BOL writes are rejected. Deploy the matching desktop and server together.

## Inspect and apply

Run from the server directory. The configured database connection is the migration target.

```powershell
node scripts/migrate-bol-documents.js --resolve-conservatively --report <dry-run-report.json>
node scripts/migrate-bol-documents.js --apply --resolve-conservatively --report <apply-report.json>
node scripts/migrate-bol-documents.js --verify --report <verification.json>
```

Quiesce server writers for the apply/cutover window. The script rescans the database and writes exclusive, fsynced Extended JSON and raw BSON backups beside the report before any database mutation. Raw BSON preserves duplicate legacy field names, including historical duplicate upload timestamps. Use a new report filename for each apply attempt so an earlier backup cannot be overwritten.

Conflicts select a whole source copy by signature presence, consensus excluding upload time, PDF presence, draft presence, latest upload time, and deterministic source ID. The user authorized this conservative rule after reviewing the conflict report. The script never combines signatures from different copies. Explicit source selections can instead be supplied with `--resolutions <json>` as `{ "loadNumber": { "outboundId": "...", "shipmentId": "..." } }`.

Each load migrates in a transaction. Source fingerprints are checked against a fresh read inside the transaction; MongoDB write conflicts prevent overwriting changes made after that read. This accepts equivalent content with different BSON field order or duplicate legacy timestamps. The transaction creates the shared document, assigns references, removes embedded fields, and archives every original copy in `bolMigrationSource`. `bolMigrationAudit` records the selected source and its fingerprint. Empty BOL fields are also archived and removed transactionally.

A failure rolls back the current load; earlier completed loads remain migrated. Rerun inspection and apply with a new report/backup path to resume. Keep the new server behind maintenance until verification passes.

Verification checks embedded fields, dangling references, document identities, unique load/unassigned identities, original source archives, and the selected document fingerprints before later edits. It also reports the reference count for load 77925000.

## Recovery

Keep both the Extended JSON backup and database source archive. If a historical selection needs correction, restore the desired whole source copy into that load's document and increment its revision. All shipment references remain unchanged. Do not restore embedded BOLs or restart the old server after cutover. A full database rollback requires quiescing writers and reviewing post-migration edits first.

Unsaved desktop drafts are retained in Pinia for the current session, including save failures. Logout or application restart clears them.
