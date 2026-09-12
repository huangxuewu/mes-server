# Finance sales invoices

MES Finance → Sales Invoices currently supports Target orders only. It lists completed outbound POs with `client: Target`, 25 per page, and rejects other or unidentified clients on every invoice action. Other customers will be implemented separately in the future. Search uses the full PO/DC number. Open a PO to review ERP prices, quantities and the invoice date before submitting.

## Ownership and connections

- ERP submits the invoice using its existing `createTransaction` GraphQL mutation: account `Domestic`, stream `LIVE`, type `INVOICE_810`. The default number is `VS` followed by the full PO with hyphens removed.
- MES checks the latest live Target domestic ASN for each shipment. Validation must be `VALID`, delivery `DELIVERED`, and acknowledgment exactly `ACCEPTED`. `OVERDUE` is not acceptance. Completed MES shipments must match ERP shipment identifiers, and accepted ASN quantities must exactly cover the whole PO. Partial PO invoicing is not implemented.
- On server startup and every five minutes, the ASN monitor checks all noticed Target POs whose loads do not have a final acknowledgment. This also discovers older noticed loads without a saved transaction ID. It resolves the exact ERP shipment and latest live 856, refreshes its status through ERP, and saves `loads.asn` with the transaction ID, validation, delivery, acknowledgment, state, check time and any lookup error. The existing outbound change stream synchronizes these records to MES clients. No open client page is required.
- Pending/overdue ASNs and transient validation/delivery failures continue checking. Strict acceptance or a rejected acknowledgment is final; a rejected ASN blocks invoicing. A new ASN submission records pending state and enables checks again. Runs do not overlap within one server process, errors on one PO do not stop other POs, and a new submission cannot be overwritten by an older check in flight. Invoice submission retains its fresh ERP acceptance check before sending and must match the ASN recorded on the noticed load; the monitor never sends invoices.
- Invoice JSON is fetched **directly from Orderful**, by the ERP-returned transaction ID, using `GET https://api.orderful.com/v3/transactions/{id}/message`. ERP invoice JSON and the local outgoing message are never used as PDF sources.
- PDF metadata, item quantities, unit prices, payment terms and total come from the retrieved 810. The invoice number, full PO, live stream and Target domestic account must match. The EDI total is authoritative; any difference from line subtotal is shown separately.
- PDFs use the existing MES Dropbox integration and are saved privately at `/DH MES/Sales Invoices/<invoice year>/<full PO>/<full PO>.pdf`. Opening a saved PDF uses an expiring Dropbox link.

## Setup

Deploy both server and client changes. Under Configuration → Integration → EDI, set the **Orderful API key** for Down Home's account. The server may alternatively read `ORDERFUL_API_KEY`. The key is sent only to `api.orderful.com`, not to ERP. The existing ERP connection and Dropbox settings remain the other required integrations.

Finance access requires `access: financial.page.access`. Sending invoices and saving PDFs additionally require `create: finance.salesInvoice.submit`; this is available in the permission editor. Admin/System retain their existing bypass. No existing user's grants are changed by this feature.

The `salesInvoice` collection has a unique integration-and-PO index. A durable claim is written before the ERP send. A timeout or crash leaves that claim in place, preventing blind resends. Check status reconciles the corresponding ERP invoice; an unresolved claim requires ERP/operator review. Failed or duplicate invoices also require ERP review, rather than automatic reissuance.

After invoice submission, the open page fetches the invoice JSON and saves the PDF when the document is valid. While waiting, it refreshes every 15 seconds while the page remains open. A failed fetch or upload stops automatic retries and shows the error. **Check status & JSON** and **Save PDF to Dropbox** can resume the remaining steps without sending another invoice. Closing the page stops this invoice/PDF polling; reopen the PO to continue. ASN monitoring runs independently on the server.

Existing Dropbox files are not overwritten. A byte-identical file can be reused after an interrupted upload/save; a different file at the same path requires review. The source JSON is stored with the invoice record for later viewing/download. Changed source JSON does not silently replace a saved PDF.

## Contract evidence and validation

On 2026-09-12, the deployed ERP invoice list/send scripts and public GraphQL schema were inspected. The existing configured MES ERP credentials were used for read-only PO checks. Three recent completed POs passed the stricter readiness checks. An existing invoice was refreshed to inspect status; no invoice was sent and no invoice PDF was uploaded during development.

The sample existing ERP invoice had `document: null`, including after its status refresh. An Orderful API key is required to verify direct retrieval and the full production save path. Reference: [Orderful Get a Transaction Message](https://docs.orderful.com/reference/transactioncontrollerv3_getmessage).

Validation commands:

```text
server: node --test test/asnMonitor.test.js test/salesInvoice.test.js test/ediAsn.test.js test/dropboxConfiguration.test.js
client: node --test test/salesInvoices.test.cjs
client: npx --no-install electron-vite build
```

PDF checks include a typical eight-line invoice, long descriptions, repeated table headers, multi-page footers, and deterministic output for conflict recovery. The actual Vue page was reviewed in an isolated fixture at desktop and narrow widths; no production submission was used for UI testing.
