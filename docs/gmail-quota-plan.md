# MES Gmail quota control plan

Prepared September 8, 2026. Approved and implemented locally. See [configuration, validation, and rollout notes](gmail-quota-operations.md). Deployment and verification of the live Google Cloud quota are still outstanding.

The objective is to keep every MES Gmail API request within a shared, conservative quota budget while preserving appointment discovery, replies, and recovery after interruptions.

## Evidence and quota baseline

The current coordinator in `utils/appointmentRefresh.js` shares an in-flight refresh and caches success for five minutes. Manual refresh bypasses that interval. In `utils/gmail.js`, each priority search can return 500 threads, and all thread downloads start through `Promise.all`. Known messages are filtered only afterward. Quota cooldown is reactive and process-local. The client appointment store waits at most 120 seconds and drops the returned `rateLimited` flag.

Google currently documents 6,000 units per minute per user per project and 1,200,000 per minute per project. Some older projects retain previously assigned quotas. Confirm the actual limits and usage for project `502079953904` in Google Cloud before rollout; its limits and production traffic have not been inspected. Current method costs relevant to MES are:

| Method | Units per request |
| --- | ---: |
| `getProfile` | 1 |
| `history.list` | 2 |
| `messages.list` | 5 |
| `threads.list` | 10 |
| `messages.get` | 20 |
| `messages.attachments.get` | 20 |
| `threads.get` | 40 |
| `messages.send` | 100 |

Source: [Google Gmail quota guidance](https://developers.google.com/workspace/gmail/api/reference/quota).

## 1. Establish the shared budget

- Verify the effective quota, applicable method costs, production server count, and whether development or other integrations use this same project and mailbox. Record these settings without storing credentials in logs.
- Set MES's per-mailbox budget to 80% of the lower of the verified limit and the documented baseline: initially at most **4,800 units per rolling 60 seconds**. Set a project-wide budget using the same rule, initially at most **960,000 units per rolling 60 seconds**. These margins are MES design choices, not Google requirements; configure lower allocations if other consumers share the quota.
- Route every Gmail operation in `utils/gmail.js` through one scheduler, including searches, reads, profile checks, sends, follow-up reads, and every retry. Reject unregistered method costs instead of assuming a cheap default. Cache the profile for the configured mailbox and invalidate it on account changes.
- Use the existing MongoDB infrastructure for atomic budget reservations, shared cooldown, and a per-mailbox sync lease with an owner token and expiry. Use database time, retain recent reservations across restarts, and reserve both mailbox and project capacity before dispatch. Stop dispatching if coordination is unavailable. Avoid a new Redis dependency.
- Key the budget by Cloud project and stable mailbox identity, not Socket.IO user, process, OAuth token, or client ID. Use a conservative project-scoped bootstrap gate until the mailbox is identified. All MES instances sharing credentials must use the same coordination store; otherwise assign separate budgets whose sum stays below the allocation.
- Enforce a weighted rolling window and smooth dispatch, with initially at most two active requests per mailbox across workers. Count failed attempts conservatively. Keep reservations close to dispatch so stale reservations cannot later create a burst. Prioritize replies ahead of bulk reads without starving sync or bypassing either budget.

## 2. Coordinate quota errors and retries

Recognize quota-specific 403 responses and 429 responses using structured status/reason details, with a message fallback for the reported error. Distinguish minute quotas from daily sending, bandwidth, authentication, and permission failures. Google recommends fewer requests and exponential backoff for user-rate errors and documents a separate concurrency limit. [Google error guidance](https://developers.google.com/workspace/gmail/api/guides/handle-errors)

- On a minute-quota error, persist a mailbox or project cooldown matching the reported scope and pause new dispatches. Existing requests may finish; do not keep launching the remaining scan.
- Honor a valid `Retry-After` or explicit retry time. For safe reads, use increasing delays with jitter, starting at one second and capped at 64 seconds; the next attempt must also wait for shared cooldown and quota capacity. Allow at most five retries per operation before marking it deferred for a later sync attempt. Repeated exhaustion should lengthen the sync pause and surface an actionable status. This follows [Google's backoff guidance](https://developers.google.com/workspace/gmail/api/reference/quota#resolve_time-based_quota_errors).
- Disable overlapping Google client-library retries for these calls so every network attempt passes through the scheduler. Confirm this against the installed transport implementation during development.
- Never automatically resend an email after an ambiguous timeout or server failure. Persist a send operation identifier and distinguish sending from fetching the sent copy. Reconcile an uncertain outcome before another send; retrying a failed follow-up read must not send again.

## 3. Make large refreshes resumable

- Replace eager `Promise.all` downloads with bounded work pulled from the scheduler. Persist pending thread IDs, search progress, completed work, and retry state. Deduplicate overlapping search results.
- Follow all relevant search pages instead of silently stopping at 50 or 500 results. Bound each execution slice and resume the remainder so a large mailbox eventually completes under the same budget.
- Coalesce manual and automatic refresh requests into the same durable mailbox job. Manual refresh may request a fresher scan but cannot bypass quota, cooldown, or an existing job.
- Keep lease ownership checks on checkpoints and commits. Make message persistence idempotent by mailbox/message ID so retries and worker takeover cannot append duplicates or lose completed work.

## 4. Reduce repeated Gmail reads

After the guarded initial scan, persist a Gmail `historyId` and use `history.list` to identify changes. Fetch only changed threads requiring appointment analysis, preserving full conversation context. Google describes partial sync and requires a full sync when an old history cursor returns 404. [Google synchronization guidance](https://developers.google.com/workspace/gmail/api/guides/sync)

- Capture an initial history boundary before the baseline scan, then replay changes since that boundary to avoid missing messages arriving during the scan. Advance the saved cursor only after all pages and corresponding database writes complete.
- Preserve both existing discovery rules: recent general mail and all-category searches for active load references. Backfill newly active or reactivated load references even when their matching mail predates the history cursor; re-evaluate stored threads when load associations change.
- On cursor expiry, schedule a paced, checkpointed baseline scan and retain existing appointment data while it runs. Treat deletion of an individual message separately from history-cursor expiry.
- Do not depend on HTTP batching to save quota: each enclosed request still counts separately. [Google batching guidance](https://developers.google.com/workspace/gmail/api/guides/batch)

## 5. Keep the client responsive and truthful

Extend the existing Socket.IO status envelope so `appointments:refresh` promptly acknowledges a queued/shared job and returns stored threads plus `syncStatus`, `lastSuccessfulSyncAt`, and `nextRetryAt`. Suggested statuses: queued, syncing, waiting, complete, and failed. Deliver completion/status through the existing socket/store conventions, with reconnect recovery from persisted state.

Update the appointment store and panel to retain status, display localized waiting/syncing text, and keep appointments usable. Do not advance the last-success timestamp or show “mailbox refreshed” for a queued, cached, or deferred result. Ensure rapid refresh clicks attach to the existing job. This avoids extending the current two-minute socket wait to cover a multi-minute scan.

## 6. Validate and roll out

Implement in order: shared scheduler and recovery, resumable refresh and client status, then incremental sync. Release the guarded refresh and its client contract together before enabling incremental sync. Proposed code areas are `utils/gmail.js`, `utils/appointmentRefresh.js`, `socket/event/appointment.js`, focused quota/sync state and tests, and the client appointment store/panel/locales. Database coordination and the additive socket fields are explicit parts of this proposed change.

Acceptance checks:

1. With a fake clock and mocked Gmail, a 500-thread scan plus searches/profile calls completes without exceeding either weighted budget in any rolling 60-second interval, including window boundaries.
2. Simultaneous clients, multiple server workers, manual refresh spam, restart, lease takeover, clock differences, and shared-store failure cannot multiply the budget or duplicate sync work.
3. Mixed methods and retries consume their assigned units; no call path or SDK retry bypasses admission. Two-worker tests validate atomic reservations, not just an in-memory mock.
4. Inject minute-quota 403/429 errors and `Retry-After` values: pending dispatches stop, shared backoff applies, retries are bounded, and non-quota failures receive the correct treatment.
5. A scan lasting longer than two minutes reports progress without socket failure; interrupted work resumes, pagination completes, and appointments contain no duplicate messages.
6. An unchanged mailbox needs no full-thread downloads after incremental sync. Test new messages during baseline, paginated history, expired cursors, deleted messages, newly active loads, and old-mail matches across categories.
7. Ambiguous send outcomes and failed sent-message reads cannot cause an automatic duplicate email.
8. Run the existing Gmail/appointment tests and relevant socket/client checks. Observe a controlled production rollout using per-method units, rolling usage, concurrency, queue age, cooldowns, and last successful sync; compare with Cloud metrics. Exclude tokens and email content from telemetry.

Success means MES-generated traffic stays within its configured allocations, large scans finish progressively, and externally imposed throttling produces a recoverable waiting state. Uncoordinated applications can still consume Google's allowance; the shared cooldown handles that case and telemetry identifies when MES's allocation must be reduced. Rollback should pause sync dispatch or disable incremental sync while retaining quota protection and stored appointments.
