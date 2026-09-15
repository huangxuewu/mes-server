# Dependency quality review — September 15, 2026

The broader service review found **26 npm production dependency advisories** in the deployed lockfile (3 critical, 15 high, 3 moderate and 5 low). The updated local lockfile reports **zero known advisories**. This is dependency hygiene and input-hardening work; the investigation has not established malicious traffic as the cause of the production memory incident.

## Changes

| Component | Validated installed version | Change |
| --- | --- | --- |
| Express | 4.22.3 | Stay on Express 4; update HTTP parsing/routing dependencies. |
| Axios | 1.20.0 | Compatible update within the existing major. |
| Mongoose | 8.24.4 | Compatible update within the existing major; verify against an isolated MongoDB 5 replica set. |
| Socket.IO | 4.8.1 | Keep the application protocol version; update parser to 4.2.7 and Engine.IO to 6.6.10. |
| ws | 8.21.3 | Remove older vulnerable nested copies where dependency ranges allow. |
| PDF-to-img / PDF.js | 7.0.0 / 6.2.108 | Use a supported wrapper for patched PDF.js. Keep explicit document destruction and disable evaluation through the wrapper options. |
| Pug | 3.0.4 | Replace legacy Jade and its vulnerable dependency chain. Rename the four templates and configure both server entry points; template content is unchanged. |
| Morgan | 1.12.1 | Update HTTP logging and header dependencies. |

Compatible transitive fixes were applied without forcing unrelated major upgrades. The template-engine and PDF-wrapper migrations were explicit and tested.

## Relevant primary advisories

- The [Socket.IO parser advisory](https://github.com/advisories/GHSA-2m8v-j782-fhvr) describes binary-attachment buffering that can exhaust memory; 4.2.7 is patched. The regression rejects zero/excessive attachment counts and accepts the application's nine-image station response.
- The [Mozilla PDF.js advisory](https://github.com/mozilla/pdf.js/security/advisories/GHSA-hq66-cqwq-w95j) identifies 6.2.108 as patched. Its described exploitation conditions concern enabled scripting and hosting-domain execution; this is not evidence of exploitation in MES's server-side thumbnail flow.
- [Pug's migration documentation](https://pugjs.org/api/migration-v2.html) documents the transition from Jade. The local templates use compatible syntax and are exercised through real Express HTTP responses.

## Validation

- 79 HTTP, authentication, socket transport, collaboration, station identity, screenshot, Live, shared-cache and tool-fetch tests passed.
- Five PDF tests passed, including 30 repeated real renders, identical thumbnail hashes, supported wire formats, concurrent document isolation and error cleanup. Settled RSS was approximately 131 MiB in this local regression process; retained ArrayBuffers did not grow. This is a synthetic renderer process, not the complete web dyno.
- HTTP checks cover dashboard/login/error rendering and escaping, URL-encoded request compatibility and payload-size rejection.
- The full data-sync replica-set suite and document cleanup integration passed: 91 tests, zero failures/skips, including pagination, shared snapshots, lost hints and process-kill recovery. Combined with the other runs, 175 tests passed for this dependency change. Deployment verification is recorded in the workspace investigation report.
- npm audit output: `tmp/server-dependency-audit.json` before and `tmp/server-dependency-audit-after.json` after, relative to the MES workspace.

An empty advisory report is a point-in-time registry result, not a claim that the service has no possible security defects.
