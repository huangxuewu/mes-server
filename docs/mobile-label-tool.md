# Mobile label access

The desktop MES labeling page remains available. The phone tool is served by the same server at:

`/addon/labelMaker/finishProduct/mobile?line=<line ObjectId>`

In desktop MES, open the production footer’s health panel, choose **Manage production** for the line, then **Open mobile label tool**. The link uses the desktop’s connected server address. A QR code can point to this URL, but MES does not generate QR codes or require a QR package.

## Employee flow

1. The operator starts the scheduled production run and confirms the employee crew in desktop MES.
2. The employee opens the line’s link and enters their existing employee PIN. No station record or station installation is needed.
3. Connect the RW403B Bluetooth printer.
4. Set **Cases / pallet** at bottom right. The maximum comes from the current production run’s saved packaging.
5. Press the large center button to register and print one pallet label. The center number is the total registered products for the current run, not a tap counter. The footer shows the active LOT.
6. Use **Next pallet** for a new physical pallet. **Reprint saved pallet** prints the same saved identity without registering output again.

Registration occurs before printing and contributes to the same production totals as desktop registration. It does not put the pallet into inventory; the existing stock-in workflow still owns that step. A failed or interrupted registration retains its request ID in local storage. A failed print retains the saved pallet. If the final print-result response is lost, the next press saves that result without transmitting the label again.

## Access and deployment

- Deploy the server and desktop client manually using the existing process.
- Use the existing `JWT_SECRET` setting in production. Mobile employee sessions last eight hours, are scoped to one line, and are separate from MES operator sessions.
- Employee eligibility is checked on each request. Creating new output requires current inclusion in that line’s crew. Employees can print only pallets they registered on that line; operators retain their existing desktop permissions.
- Mobile registrations and print attempts use employee reference fields; employee IDs are not stored as MES user IDs.
- Use a phone-accessible HTTPS server address. `localhost` in a desktop development link refers to the phone itself when opened on a phone. A plain LAN HTTP page cannot provide browser Bluetooth access.
- Both the original browser page and the mobile layout load the same `assets/rw403b.js` module, extracted from the existing tested code. The page uses the existing RW403B BLE protocol and a 4-by-6-inch, 203-dpi label canvas. It detects unavailable browser Bluetooth support. Android Chrome over HTTPS is the intended direct-browser target; confirm the actual phone and printer before rollout. A different printer or an iPhone may need a different integration.
- HTTP endpoints under `/mobile/api`: `POST /login`, `GET /context`, `POST /register`, `POST /prepare-print`, `POST /print-result`. All except login require the scoped employee Bearer token. No station registration or desktop app token is exposed by the mobile page.

## Verification

Automated database tests cover PIN access, invalid or unassigned employees, operator-token rejection, line isolation, employee audit identity, duplicate requests, shared desktop totals, LOT changes, crew removal, and PIN/status revocation. Desktop lifecycle and pallet tests pass against an isolated replica set.

The browser walkthrough checks the actual page at phone/tablet widths, case entry, label raster/barcode generation, simulated Bluetooth writes, registration-response loss, printing failure, reload recovery, and result-only retry. The RW403B browser connection has already been tested successfully onsite by the user. A byte-for-byte regression test verifies that extraction preserves the original printer commands (51 frames / 20,237 bytes for the reference raster). Both browser layouts pass simulated-device walkthroughs; the new label layout and barcode remain available for an onsite print check.
