# Gmail quota controls

MES now accounts for every Gmail data request in MongoDB before dispatch. The default allocation is 4,800 units per mailbox and 960,000 per project, with a rolling 60-second window, smooth pacing, and at most two active requests per mailbox. Completed requests retain their cost for another full minute, deliberately leaving extra room around dispatch latency. A project-wide minimum spacing of 250 ms also bounds the size of the reservation ledger.

## Configuration and rollout

| Server environment variable | Default | Purpose |
| --- | --- | --- |
| `GMAIL_QUOTA_PROJECT` | Numeric prefix of OAuth client ID | Set explicitly to `502079953904` after confirming the configured OAuth client belongs to this project. |
| `GMAIL_USER_QUOTA_LIMIT` | `6000` | Verified per-user/project minute limit. MES allocates 80%, capped at 4,800. Lower this to allocate capacity to other consumers. |
| `GMAIL_PROJECT_QUOTA_LIMIT` | `1200000` | Verified project minute limit. MES allocates 80%, capped at 960,000. |
| `GMAIL_SYNC_PAUSED` | unset | `true` pauses background sync dispatch. Sending still uses the quota gate. |
| `GMAIL_INCREMENTAL_SYNC` | unset | `false` uses paced baseline scans for new cycles instead of history-based incremental sync. |

All MES processes using the same Gmail credentials must share the coordination database. Development environments with a separate database should use separate Gmail credentials, disable Gmail activity, or have explicitly partitioned quota allocations. The gate cannot account for unrelated applications using the same mailbox/project.

Before deployment, inspect [the project's Gmail quotas](https://console.cloud.google.com/apis/api/gmail.googleapis.com/quotas?project=502079953904), verify effective limits, and configure lower allocations if needed. The actual Cloud settings and production traffic were not accessed during implementation. Method weights follow [Google's Gmail guidance](https://developers.google.com/workspace/gmail/api/reference/quota); retained older quotas may differ.

Deploy the server and client changes together. Retire old server workers before allowing Gmail activity: old binaries do not use the new gate. MongoDB must support transactions (replica set); existing MES change streams already require a replica set. Do not erase quota records during restart or rollout.

The first sync or send associates legacy `emailThread` records without a mailbox with the currently configured, authenticated mailbox. Keep the original mailbox connected for this upgrade. The upgrade first creates a unique `(mailbox, threadId)` index, preserves records, and removes only the old unique single-field `threadId` index. Subsequent mailbox changes preserve separately scoped records. Configuration-test requests do not perform this migration. Reverting to an older application version after migration requires a compatibility review; pause sync instead for operational rollback.

The persisted quota uses the smallest allocation any worker has reported. Reducing environment limits applies automatically. Raising them later requires a coordinated, reviewed update to the matching `gmailQuota` document's `userBudget`/`projectBudget`, while retaining its reservations and cooldowns. Do not change limits on only one worker.

## Sync and retries

`appointments:refresh` acknowledges the durable job immediately. `appointments:sync-status` retrieves the same status, and its server event publishes updates. The client also checks status every ten seconds while a job is active and on reconnect, so notifications work across server processes without adding a Socket.IO adapter. The five-minute normal refresh interval remains in place. Manual refresh shares active work and cannot bypass cooldown.

Each job step processes a search/history page or one thread. Search pagination and pending thread IDs survive restart. Appointment writes, deduplication, and the checkpoint commit in the same transaction under a renewable lease. The first scan captures a history boundary and replays arrivals; subsequent scans read history and backfill newly active load references. An expired history cursor schedules another guarded baseline. Duplicate messages are guarded by mailbox and message ID.

Rate and transient failures pause dispatch at the appropriate shared scope. Retry-After, explicit retry dates, and structured RetryInfo are honored. Backoff adds jitter and increases to a 64-second ceiling, with at least a minute for minute-quota failures. After five retries, successive retry groups defer for increasingly long intervals, capped at one hour. Authentication and permission failures are marked failed instead of repeatedly consuming Gmail quota. Failed attempts still consume the local allowance. Google SDK data-request retries are disabled; token acquisition occurs separately and cached OAuth clients reuse access tokens.

Interactive requests can wait up to five seconds for admission. Once dispatched, Gmail data requests have a 20-second transport timeout. The reply socket allows 60 seconds for authorization, admission, and reconciliation. Failed admission never starts a send. Send operation IDs survive client retries/reloads without storing message content in localStorage. Once a send starts, uncertain outcomes are reconciled against Sent mail by Message-ID; MES never automatically sends that operation twice. A known successful send uses its persisted result without fetching or sending it again.

## Operational evidence

- `gmail.request`: method, charged units, conservative rolling mailbox units, and duration. No credentials or email bodies are logged.
- `gmail.sync.deferred`: retry category, error code/name, and attempt count.
- `gmail.sync.unavailable`: coordination failure; no new request is admitted when coordination is unavailable.
- `gmailQuota`: active reservations, project/mailbox cooldowns and pacing, and effective allocations.
- `gmailSync`: job status, requested time, last successful sync, next retry, current checkpoint, and lease owner/expiry.
- `gmailIdentity`, `gmailSyncSeen`, and `gmailSend`: cached mailbox identity, current-cycle deduplication, and durable send outcomes.

During rollout compare local request metrics with Google Cloud usage, check queue age and last-success time, and confirm an unchanged mailbox performs no full-thread downloads. External consumers may still cause Google to throttle MES; the expected behavior is a recoverable waiting state with the previous successful timestamp retained. Production verification and deployment remain outstanding.

## Validation

Run the focused server suites:

```powershell
node --test utils/gmail.test.js utils/gmailQuota.test.js utils/gmailSync.test.js utils/appointmentRefresh.test.js utils/appointmentFilter.test.js utils/emailWeight.test.js utils/emailSignature.test.js test/gmailIntegration.test.js
```

The integration suite requires `GMAIL_TEST_URI` pointing to an isolated localhost replica set with a database name beginning `gmail_test_`. It creates uniquely named test databases; it never uses MES's production connection or sends Gmail messages. Without this variable, the database-dependent tests are skipped. Tests cover a simulated 500-thread scan, rolling-window boundaries, two independent database connections, shared cooldown, lease takeover, persisted send outcomes, mailbox migration, pagination, cursor expiry, and old-mail backfill.

Run `node --test test/appointmentSync.test.cjs` in the client for job status, reconnect recovery, and stable send IDs. Use `npx --no-install electron-vite build` to verify the client without changing release metadata or publishing.
