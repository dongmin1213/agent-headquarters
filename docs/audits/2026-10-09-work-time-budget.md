# Visible execution time budgets and closeout recovery

After two accepted checkpoints, V01 hit its generation-wide 270-minute supervised-time cap while preparing the next submission. Its last commit and in-repository progress report survived, but out/report.md and out/done.json had not been written. This was a different limit from the checkpoint-count defect. The previous recovery had not exposed the remaining time.

Worker prompts now receive both the attempt cap and remaining generation time, using the same supervised clock as enforcement. The smaller limit takes priority over generic checkpoint timing, and up to ten minutes is reserved for commit/report/done submission. An already exhausted generation is blocked before another paid worker starts. Sleep/outage handling and hard time limits are unchanged.

Validation: TypeScript check; checkpoint recovery/cap/stale-evidence tests; supervised clock sleep/restart tests; and continuation tests with five minutes remaining or no time left. The latter verifies that exhausted time does not create another attempt.

Runtime: stopped HQ, backed up its database, and validated the replan on a copy. Preserved a16's sealed 6fa2a67e commit, prior attempts, time/usage ledgers, and all acceptance/review/dependency/ownership requirements. Applied a new execution contract focused on remaining UI and presentation evidence, with hash-valid reuse of completed boss, health, and ending observations. One fresh-context production dispatch was authorized for that changed method; the new contract receives the existing bounded time allowance. Request-wide attempt cap remains 140. No completion or quality approval was granted.
