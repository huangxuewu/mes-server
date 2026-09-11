# Automatic ASN after MES BOL upload

## Scope

MES uploads the BOL PDF to its existing Dropbox destination and saves the link. When `Auto Submit ASN` is selected, MES then submits ASNs for loaded POs. The option defaults to off. MES does not upload the PDF to ERP or update the ERP load through `upsertLoad`.

## ERP contract

The ASN contract was inspected on 2026-09-10 using the deployed ERP ASN screen and GraphQL schema.

- Match each ERP `loadShipment` by load number, full PO/DC number and ShipIQ `load_shipment_notice_id`. Its mapped shipment ID must agree and its notice must not be cancelled.
- Read the vendor's `ediAccounts.isa_id`; the supported DMS account maps to `Domestic`.
- Send EDI 856 shipment/order/carton/item JSON through `createTransaction` with account code `Domestic`, stream `LIVE` and type `SHIP_NOTICE_MANIFEST_856`.
- Use the ERP load-shipment ID for shipment identification, and the saved MES BOL number for MB and BM references.
- Sending units are MES `quantity - backorder`. Match each item uniquely, validate case packs and PO quantities, and use the existing ERP SSCC carton labels.
- Save required partial-quantity adjustments with `upsertLoadShipmentAdjustments`.
- Completion requires an ERP transaction ID and saved quantity adjustments. MES does not poll EDI delivery or partner acknowledgement.

Existing accepted or in-progress transactions are checked against the MES BOL and carton/item contents and reused. Different contents require ERP review. Every selected PO is validated before the first create, and a fresh ERP read precedes each create. The existing EDI configuration supplies the API origin and credentials; no browser credentials are copied.

## MES flow and status list

The outbound Pinia store owns upload and ASN state for both BOL dialogs. After the Dropbox upload and MES link save, the client checks `bill-of-lading:asn-ready` with an eight-second timeout. It then sends load number, loaded shipment IDs and a request ID to `bill-of-lading:submit-asn`. The PDF is not included in this request. The server reloads authoritative shipment records from MongoDB.

Both dialogs display `Upload BOL` followed by a load-number badge. The list includes all selected POs, with the loaded/total count in the heading when some are unloaded. Unloaded rows display `Shipment Not Loaded`. Active rows display `Submitting` followed by animated dots. Successful rows display `Received by ERP`. There is no ERP document-upload row.

Failed or unsent PO rows offer `Retry` with a refresh icon beside the PO number. A retry creates or adjusts only that PO and preserves other row statuses and the saved MES Dropbox upload. The client finishes when all loaded rows are received. `Attention needed` opens `/shipping/asn/send?shipment_id=<ShipIQ shipment ID>` in the default browser.

The footer button retains its width and height while showing loading dots. `Confirm` starts the initial upload or dismisses completed results; ASN retries are per PO. In the gate dialog, confirming results finishes the existing load-completion flow.

## Verification and limitations

Mocked server tests cover payloads, partial quantities, existing and ambiguous receipts, adjustment retries, pending partner processing and absence of ERP document uploads or load updates. Client tests cover PO status progression, retry isolation, callback reconciliation, unloaded rows, duplicate clicks and omission of PDF bytes from ASN requests.

The server has a per-load process lock and an in-memory guard for create requests with unknown outcomes. These do not provide durable distributed idempotency. ERP transaction records remain the authority after an ambiguous response or server restart.
