# Finance sales invoices

MES Finance → Sales Invoices supports Target orders only. Its starting point is completed MES loads with a `checklist.noticed` field. It returns all eligible POs that are ready to invoice, plus unresolved invoice submissions; historical finalized orders and orders still waiting for ASN acceptance are excluded. Every invoice action rejects other or unidentified clients. The existing top search filters loaded view data, the filter selects load numbers, and the dock counts master POs separately from individual destination orders.

The page reads saved `queueRow` snapshots from the existing `salesInvoice` collection, scoped to the configured integration. It makes no ERP or Orderful calls. The server invoice monitor refreshes this queue on startup and every five minutes: it fetches ERP PO and shipment summaries without JSON documents, then verifies current candidate transaction IDs, statuses, timestamps and documents directly with Orderful. Existing ERP invoices without a MES submission record are outside this new feature queue; their presence is used to identify history, not to infer acceptance. Direct verification runs for up to four POs concurrently. It still checks exact shipment quantities before declaring a PO ready. The open page reads saved rows every 15 seconds. Loading failures release the spinner; stale list/detail responses cannot replace newer submission or selection state. Opening the review and submitting still verify current Orderful data, so a cached ready row cannot authorize a send.

## Ownership and connections

- ERP submits the invoice using its existing `createTransaction` GraphQL mutation: account `Domestic`, stream `LIVE`, type `INVOICE_810`. The default number is `VS` followed by the full PO with hyphens removed.
- MES checks the latest live Target domestic ASN for each shipment using Orderful metadata, acknowledgment and message endpoints. Latest means Orderful's `createdAt`, not ERP's copy of the date. Validation must be `VALID`, delivery `DELIVERED`, and acknowledgment exactly `ACCEPTED`. `OVERDUE` is not acceptance. Completed MES shipments must match ERP shipment identifiers, and accepted ASN quantities must exactly cover the whole PO. Partial PO invoicing is not implemented.
- On server startup and every five minutes, the ASN monitor checks all noticed Target POs whose loads do not have a final acknowledgment. This also rechecks noticed loads whose saved final status predates Orderful source tracking. ERP supplies transaction IDs and shipment mapping; Orderful supplies the status and dates. The monitor resolves the exact shipment and latest live 856, reads Orderful directly, and saves `loads.asn` with the transaction ID, validation, delivery, acknowledgment, state, check time, `source: orderful` and any lookup error. `checklist.noticed.timestamp` is Orderful transaction creation time; `acceptedAt` is the accepted acknowledgment's creation time. Check time is never displayed as acceptance time. The existing outbound change stream synchronizes these records to MES clients. No open client page is required.
- Pending/overdue ASNs and transient validation/delivery failures continue checking. Strict acceptance or a rejected acknowledgment is final; a rejected ASN blocks invoicing. A new ASN submission records pending state and enables checks again. Runs do not overlap within one server process, errors on one PO do not stop other POs, and a new submission cannot be overwritten by an older check in flight. Invoice submission performs a fresh Orderful acceptance and exact quantity check before sending, including any saved transaction ID not yet listed in ERP; the monitor never sends invoices.
- Invoice JSON is fetched **directly from Orderful**, by the ERP-returned or MES-recorded transaction ID, using `GET https://api.orderful.com/v3/transactions/{id}/message`. ERP invoice JSON and the local outgoing message are never used as PDF sources.
- PDF metadata, item quantities, unit prices, payment terms and total come from the retrieved 810. The invoice number, full PO, live stream and Target domestic account must match. The EDI total is authoritative; any difference from line subtotal is shown separately.
- PDFs use the existing MES Dropbox integration and are saved privately at `/DH MES/Sales Invoices/<invoice year>/<full PO>/<full PO>.pdf`. Opening a saved PDF uses an expiring Dropbox link.

## Setup

Deploy both server and client changes. Under Configuration → Integration → EDI, set the **Orderful API key** for Down Home's account. The saved setting is the only credential source. The key is sent only to `api.orderful.com`, not to ERP. The existing ERP connection and Dropbox settings remain the other required integrations.

Finance access requires `access: financial.page.access`. Sending invoices and saving PDFs additionally require `create: finance.salesInvoice.submit`; this is available in the permission editor. Admin/System retain their existing bypass. No existing user's grants are changed by this feature.

The `salesInvoice` collection has a unique integration-and-PO index. A durable claim is written before the ERP send. A timeout or crash leaves that claim in place, preventing blind resends. Check status reconciles the corresponding ERP invoice; an unresolved claim requires ERP/operator review. Failed or duplicate invoices also require ERP review, rather than automatic reissuance.

After invoice submission, the open page checks pending invoices every 15 seconds. JSON retrieval and PDF storage can retry without sending another invoice. The server also checks MES-submitted invoices on startup and every five minutes, so closing the page does not stop result retrieval or PDF storage. Checks run sequentially without overlapping within a server process; an error on one PO does not stop the others. Rejected/invalid/failed transactions need operator review. A confirmed acceptance plus saved PDF ends server polling. The monitor never submits an invoice.

## Review and batch submission

The dock's batch action opens a compact load selector using the Shipment Details typography, black data values, slate controls, fixed frame and scrolling body. Only loads with eligible POs are selectable. Start review opens each PO's existing ERP Invoice Review in sequence; **Approve** saves that PO's reviewed values in Pinia and advances to the next PO. All eligible POs in the selected load must be approved before **Submit approved invoices** is enabled. Approvals are local draft state and do not survive an application restart.

Invoice number/date, ship date, SCAC and BOL edits are included in the submitted message. Prices, PO identity, item identifiers and terms remain server-owned. Quantities must match the fully loaded PO and accepted ASNs. The server rechecks ASN acceptance directly with Orderful and fingerprints both the current source data and ERP form defaults immediately before each send. Changed source data requires a new review. Reopening an approved PO also requires approval again.

Batch sends use the existing ERP mutation sequentially, with a durable claim per PO. Successful POs are not sent again if another PO fails. Ambiguous results stay unavailable for submission until a status check reconciles them; a claim with no identifiable ERP result requires operator investigation. The batch summary retains per-PO outcomes after finalized rows leave the main queue. The review matches ERP's shipment selection, Central Time dates and SCII/SQKO → SOCS mapping. The final PDF still comes exclusively from Orderful JSON.

Existing Dropbox files are not overwritten. A byte-identical file can be reused after an interrupted upload/save; a different file at the same path requires review. The source JSON is stored with the invoice record for later viewing/download. Changed source JSON does not silently replace a saved PDF.

## Contract evidence and validation

On 2026-09-12, the deployed ERP invoice list/send scripts and public GraphQL schema were inspected again. The existing configured MES ERP credentials were used for read-only PO checks. PO `10001985846-0554` had four line items totaling $9,834.48, matching the ERP invoice form's item query. Its selected load was `77906146`; carrier and BOL defaults were checked against the deployed form. No live invoice was submitted or invoice PDF uploaded during this review.

An earlier ERP-payload optimization measurement returned the same 26 rows: ERP response data fell from 57,434,613 bytes to 3,923,418 bytes (about 93% less), and elapsed time fell from 13.3 seconds to 9.9 seconds. This historical measurement predates direct Orderful status verification. With direct verification enabled, the current live list returned 26 POs, all 26 ASN submission times and all 26 acceptance times, in 41.9 seconds. These are individual measurements, not latency guarantees. ERP pagination and direct Orderful request latency both contribute to loading time.

The user-authorized Orderful token was saved in the active MES setting and verified with read-only requests to Orderful. Existing transaction `1040371728`, PO `10002045378-3806`, returned `VALID / DELIVERED / ACCEPTED`, matching ERP metadata. Its direct Orderful JSON contained two lines, 1,233 units and an invoice total of $13,792.53. The existing PDF generator rendered that JSON successfully to a single page, visually checked for totals, identifiers and clipping. The resulting storage path is `/DH MES/Sales Invoices/2026/10002045378-3806/10002045378-3806.pdf`; the verification PDF was generated locally, not uploaded. Reference: [Orderful Get a Transaction Message](https://docs.orderful.com/reference/transactioncontrollerv3_getmessage). Target acceptance here means EDI functional acknowledgment, not payment or proof of physical delivery: [Orderful transaction statuses](https://docs.orderful.com/docs/transaction-statuses).

Validation commands:

```text
server: node --test test/ediAsn.test.js test/outboundFollowup.test.js test/asnMonitor.test.js test/asnTimestampMigration.test.js test/invoiceMonitor.test.js test/salesInvoice.test.js test/orderfulConfiguration.test.js
client: node --test test/salesInvoices.test.cjs test/dropboxPreviews.test.cjs
client: npx --no-install electron-vite build
```

PDF checks include a typical eight-line invoice, long descriptions, repeated table headers, multi-page footers, and deterministic output for conflict recovery. The actual Vue components were reviewed in an isolated fixture. A three-PO batch was reviewed sequentially, blocked invalid SCAC input, unlocked submission only after all approvals and displayed final results with repeat submission disabled. Submission and Orderful responses in that UI check were mocked. Automated tests cover approval isolation, stale fetches, changed ERP defaults, duplicate protection and PDF retry. The production MES server was not started for verification; deploy both sides to activate the added monitor and batch flow.

## Historical ASN timestamp migration

The September 12 review found 26 current queue loads with `checklist.noticed.status: false`, a null submission timestamp, no acceptance timestamp and no saved ASN transaction ID, although ERP showed accepted ASNs. Previously, the list used ERP acceptance but read timestamps from the MES checklist, while the monitor skipped loads with `status: false`. The queue verifier reads both status and timestamps from Orderful; the page displays its saved result. All 26 dates were confirmed before the database backfill. The migration aligns persisted history and enables normal monitoring for these records. New submissions retain a local dispatch flag and transaction ID; the displayed EDI timestamps remain empty until Orderful provides them.

Run from the server directory with the existing ERP and MES Orderful configuration:

```sh
node scripts/migrate-asn-timestamps.js --dry-run
node scripts/migrate-asn-timestamps.js --apply
# Optional explicit full PO scope:
node scripts/migrate-asn-timestamps.js --dry-run --po=10002045378-3803
```

The default scope is only the current sales-invoice queue, not all historical Target orders. Each run writes a new JSON report under `tmp/`; `--report=FILE.json` selects a different unused filename. Dry run is the default. Exit code 2 indicates skipped or concurrently changed records requiring review; code 1 indicates a fatal error.

The script matches the exact MES PO, shipment and load to live domestic 856 IDs, then selects the latest accepted ASN by Orderful creation time and verifies its identity, PO references and shipment identifier directly with Orderful. ERP status and timestamp values cannot approve or reject a migration candidate. It uses `transaction.createdAt` as the historical submission proxy (receipt/creation at Orderful) and `acknowledgment.createdAt` for acceptance. It does not use ERP `asn_sent_at`: in the inspected sample that value was later than the acknowledgment. Missing or conflicting evidence is skipped; current time and `lastUpdatedAt` are never substituted for missing historical timestamps. See [Orderful acknowledgment endpoint](https://docs.orderful.com/reference/transactioncontrollerv3_getacknowledgment).

Apply fills missing checklist timestamps, corrects conflicting historical dates to the verified Orderful dates, marks the noticed status true and saves the matching accepted ASN transaction state with its source. Already matching records are unchanged. Original values and proposed changes are saved to the report before each write. ERP is rechecked immediately before writing, and conditional Mongo updates reject changed loads rather than overwriting concurrent edits. Rerunning completed records is a no-op. The existing checklist date fields are reused; the ASN model now also stores its status source. The script does not submit invoices or write to ERP.

The read-only dry run matched all 26 current queue loads: submissions ranged from September 10 to September 11, 2026, with corresponding accepted acknowledgments. The authorized migration was subsequently applied to all 26 current POs, and a read-back verified both timestamps and Orderful source markers with no failures. Original values are retained in `tmp/asn-timestamps-2026-09-12T22-56-27-722Z.json`. Validate the migration with `node --test test/asnTimestampMigration.test.js`.

Component loading states use the existing shared `load-spin-ring` animation and the small, thin, muted variant from Shipment Details. The main list retains the Production Orders initial-loading overlay style.

## Orderful status authority

`utils/edi/orderful.js` is shared by invoice reads/submission checks, the ASN monitor, existing-ASN verification during shipment submission, and migration. It verifies the transaction ID, live Target domestic accounts, document type, business number, PO references and shipment identity. A missing key, API failure, missing accepted acknowledgment, conflicting acknowledgment or invalid timestamp fails closed; ERP values are never substituted. `OVERDUE` remains pending, including in the ASN submission flow.

Invoice refresh stores `statusSource`, `submittedAt`, `acceptedAt` and `statusCheckedAt` separately from the durable local `submissionStartedAt` claim. It updates checklist dates using Orderful data, including corrections to older poll-time dates. Stored IDs are verified directly even when ERP has not indexed them yet. The client shows Verifying with Orderful after ERP returns an ID; the invoice stage completes only when an Orderful submission timestamp is available. Legacy MES invoice records without `statusSource: orderful` are rechecked by the invoice monitor before their cached terminal status can stop polling. Shipment loaded time remains MES-owned.

The Orderful-aware migration was tested with stale ERP statuses, missing and incorrect dates, conflicting identities, replacement ASNs, report failures and concurrent load updates. Direct source tests cover list/review disagreement, fresh pre-send checks, invoice JSON and timestamps, source failures and ordering by Orderful creation time. No live ASN or invoice was submitted during these checks, and no migration was applied.


## Fast list reads

On September 12, the 26 current queue rows were verified and saved in MongoDB. Three database-only list reads took 1,209 ms, 1,043 ms and 995 ms, compared with the earlier 39-second live list. All 26 POs retained both ASN timestamps. These are server-query measurements, excluding browser rendering; see `tmp/invoice-cache-benchmark.json`. The verification and cache population took 49 seconds and is background work.

`queueCheckedAt` records when a verification run started, separate from EDI event times. Only a successful full verification scan removes obsolete rows. A source failure leaves the last verified snapshot available. Conditional writes prevent an older scan from replacing a newer snapshot. List reads overlay durable submission claims and current Orderful invoice results, preventing stale ready rows from re-enabling submission and hiding finalized invoices immediately. Snapshots preserve the verifier's row order. Cached readiness is presentation only; the existing fresh Orderful check, quantity checks and duplicate claim remain mandatory before sending.

The two added fields are `salesInvoice.queueRow` and `salesInvoice.queueCheckedAt`; no separate cache service or client-side business state was introduced. The existing server monitor owns refreshes, and the existing Pinia store owns list loading. New environments initially have no saved rows until the startup monitor completes. This database has already been populated for the current 26 POs. Restart the updated MES server and reload the updated client to activate background refresh and the faster page; the benchmark did not start or restart the MES server.
