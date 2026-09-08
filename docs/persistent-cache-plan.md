# Persistent cache implementation review

Implemented behavior and operational details are documented in [data-sync.md](data-sync.md).

The startup working set remains available through its existing Pinia stores. The shared coordinator now covers 21 operational datasets, encrypted persistent checkpoints, revision-based configuration/schedule caching, and protected dependency refreshes. Historical queries remain on demand. All cache work runs behind the scenes.

The project-wide review addressed competing full-list writers, unversioned broadcasts, the global employee focus-refresh plugin, outbound child-load removal, factory-date filtering, scheduled configuration activation, cache-write failure recovery, namespace races, portrait URL races, and bounded query storage.

Read checkpoints commit records and their cursor together; they never contain or clear the independent punch queue. OS-backed key storage protects persisted record bodies. No credential or cached permission becomes an authorization source. Online station resolution remains the existing startup boundary; completely offline cold-start routing is a separate capability, not part of this delivery.

Deployment remains server first. Expanded capture uses a separate v2 journal/state identity while retaining wire protocol v1, so older clients and servers can coexist. Mixed server pools can trigger extra snapshots while generations differ. Retire the old consumer only after server migration completes.

Next improvements should follow measurements: compare warm/cold startup stages, bytes per dataset, capture lag, reset frequency, and disk/encryption costs. If access projections later differ across stations or users, introduce server-issued capability/projection versions alongside cache invalidation. Keep the existing operational startup set and fetch history only when needed.
