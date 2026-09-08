# Sync correction plan

1. Capture safety: report successful-poll heartbeat separately from captured source time, keep backlog visible, reinitialize metadata after database replacement, and retain lease fencing/checkpoint transactions.
2. Protocol recovery: periodically reprobe uncertain legacy fallback, separate metadata sweeps from forced legacy reads, and explicitly confirm subscriptions before suppressing legacy broadcasts for upgraded clients.
3. Scope and projections: include factory timezone in opaque daily generations; reset only timecards when a referenced approver projection changes. Preserve the existing date scope and record shapes for compatible clients.
4. Domain correctness: consume acknowledged hauler IDs in a Pinia-owned gate assignment; preserve the already loaded message/topic window during background refresh; discard stale queued image URLs before starting requests.
5. Validation: keep the nine behavioral regressions, adapt assertions where explicit dataset reset or acknowledgement consumption is the corrected contract, add negative/selectivity/race checks, rerun all 485 baseline cases plus new cases, real process crash/replica failover, and the non-publishing production build.

The work adds no user-facing sync controls, keeps shared data in Pinia, preserves the independent punch queue, and avoids production database connections. Native packaged-client acceptance and production-scale soak remain rollout follow-ups.

Completed: all five steps are implemented. Final validation is 495/495 passing tests, zero skips, and a successful non-publishing production build. See [data-sync-validation.md](data-sync-validation.md) for coverage and remaining native-client rollout checks.
