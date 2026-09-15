# Query audit — September 15, 2026

## Outcome

Active outbound load editors and picking slips reuse the current Pinia working set. Appointment candidates and monthly load counts no longer join BOL documents. Search scans shipment search fields once and fetches only the referenced standalone BOL numbers in one indexed batch.

These are local changes, not deployed fixes. Deploy the server before the client because the client now calls `outbound:load-counts`.

## Standalone BOL migration verification

A read-only production check found 3,190 outbound documents, zero parents with `loads.bol`, 3,189 parents with a non-null `loads.bolId`, and 1,310 standalone `bolDocument` records. No document had a raw-data BOL number without its canonical `number`. An outbound document without a BOL reference is not necessarily invalid.

Shipment writes continue to reject embedded BOL bodies. Search and signature-pad lookup use canonical BOL numbers; signing and ASN operations still fetch the full standalone document when they need it. Signature-pad lookup no longer includes an unindexed `rawData.bill_of_lading_number` alternative, and a missing BOL stops before reading shipments.

The v3 data-sync consumer watches standalone BOL changes and journals the affected outbound parent IDs. List synchronization includes small `bolSummary` fields, not `rawData`. The BOL lookup before outbound working-set membership filtering remains necessary: a completed non-parcel shipment with no BOL URL can still belong to the operational set. Moving that membership filter or a page limit ahead of enrichment would change which shipments operators receive.

## Query review and changes

The accompanying `query-audit-inventory-2026-09-15.json` inventories 450 candidate read/populate/lookup sites across 213 runtime JavaScript files (94 with candidates). This static inventory covers socket handlers, API/routes, models and utilities; it excludes tests, migration scripts and dependencies. It is a review index, not proof that every dynamic query is optimal or that every path has been profiled in production.

| Query family | Change or retained requirement |
| --- | --- |
| Active load opening / picking | Use current unfiltered Pinia rows across all POs in the load; clone editor drafts so edits do not mutate synchronized data. |
| Appointment candidates | Filter active shipment children and project/group the matching fields without fetching BOL summaries or full shipment records. |
| Active load server reads | Filter parent status before BOL enrichment, then retain the original child filter. |
| Targeted load reads | Apply parent ID, PO, load number and pickup date restrictions before BOL enrichment; retain the final flattened-row predicate. |
| Outbound history | Push an initial native `loads.$elemMatch` filter before enrichment only for explicitly supported non-BOL fields. BOL-dependent conditions remain after enrichment. |
| Monthly load counts | Dedicated narrow pipeline counts distinct load/month pairs with no BOL lookup. |
| Global search | One projected outbound scan, one deduplicated `_id` batch for BOL numbers, and narrow order fields. Preserve first-shipment selection for duplicate numbers. Ignore unreferenced BOL documents. |
| BOL search UI | Match the returned `bol` string; use the working set for active load-number results and the server for history. |
| Message topic lists | Batch read markers and unread counts in two reads per page, replacing two reads per topic; preserve timestamp/ID boundaries, author exclusion and deleted/retracted exclusions. |
| Related-document access | Project only access-control fields when checking linked documents. Fresh authorization reads remain required. |
| Other document, form, personnel and workflow queries | Retain relationship population needed by returned screens and authorization. No blanket removal of joins. |
| Production metrics / health | Retain filtering by production run before aggregation and the bounded per-line metrics required by the health view. |
| Inventory startup and synchronization | Retain the operational working sets and correctness of membership/pagination. Do not replace required startup data with arbitrary pagination. |
| EDI / BOL workflows | Retain batched reference resolution and full BOL reads where signing or ASN content is needed. |
| Resource cleanup | Retain document/revision reference checks needed to avoid removing shared resources. |

## Production read-only measurements

Measured on the same production data using the previous committed handler and the revised handler, with direct MongoDB reads and bounded `maxTimeMS`. No production data was changed and no service was restarted. These are samples, not a load test or deployed application timing.

| Operation | Previous MongoDB execution | Revised MongoDB execution |
| --- | --- | --- |
| Monthly load counts | 674 ms | 16 ms |
| Search shipment fields | 44 ms | 16 ms |
| Search BOL data | 681 ms (second outbound scan plus enrichment) | 4 ms (referenced BOL number batch) |
| Search order fields | 7 ms | 7 ms |

Monthly counts took 690 ms versus 57 ms including transfer in the final paired sample. Search transfer remained variable: the final sample took approximately 13.8 seconds before and 13.9 seconds after despite the lower database execution time. Do not claim an end-to-end search latency improvement from these measurements. The earlier production investigation also observed R14 memory pressure and swapping; these query changes do not establish that the original timeout incident is resolved.

Count results were identical. Search retained all 3,242 unique PO numbers, 1,150 load numbers and 1,210 BOL numbers, with matching representative shipment IDs and status/done values. Empty search keys are excluded. The response remains approximately 441 KB; database work was reduced without removing searchable business data.

## Validation

- Server query, appointment, message and document suites: 63 passed, no failures or skips.
- Server BOL document, signature-pad, ASN and invoice suites: 61 passed, no failures or skips.
- Client outbound failure, order summary, history and picking-slip suites: 31 passed, no failures or skips.
- Client production build: `npx electron-vite build` passed.
- Local MongoDB integration tests use guarded disposable localhost databases. Duplicate standalone BOL numbers retain the first shipment, including when insertion order differs from ObjectId order.
- Production comparisons are read-only and verify search and count result equivalence.

Full BOL content, historical data absent from Pinia, explicit post-mutation refreshes and fresh authorization still require server reads. Ordinary active-load opening does not requery shipment details.

## SignPad follow-up

Traced Android `BolApi` and barcode lookup/generation/signing, the server HTTP endpoints, MES socket printing, the Pinia signature store, and checklist workflows. Android sends barcode/grant requests and does not read an embedded shipment BOL. MES saves through `bol-document:save`. Checklist scans operate on shipment checklist fields without a BOL join.

- Canonical barcode lookup reads `bolDocument.number`, then finds shipments by indexed `loads.bolId`. It projects only BOL source fields and the shipment fields needed for generation, status validation and source revision checks. Gate lookup projects only trailer and seal.
- Existing-document scans with `allowCreate` reuse their already-read targets instead of reading the same document and shipments again. For a BOL with trailer/seal already present, the business-data reads drop from four to two. Device/user authorization remains separate and fresh.
- Generation retries also reuse the target read inside their transaction. Transactional rereads for signing and gate updates, post-commit reads and print verification remain necessary.
- Scan/sign/reprint revisions now include the standalone document ID. Replacing the referenced document with identical content invalidates the old grant. Multiple referenced documents sharing one number/load are rejected before a single-document write could produce a partial result.
- Server SignPad access/documents/workflow/pairing and BOL document suites: 60 passed, no skips. Client SignPad and BOL signature suites: 42 passed, no skips. These include a real local replica-set test of 19 shared references, rollback, concurrent signing, idempotent retries and reprints. No physical tablet/emulator validation was performed in this follow-up; Android source and wire fields did not change.

Changes remain local. Deploying the revised grant calculation invalidates previously scanned grants; rescan those BOLs after rollout. Saved signatures remain intact.
