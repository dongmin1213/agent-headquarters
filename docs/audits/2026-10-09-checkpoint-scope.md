# Contract-scoped game continuation accounting

The game worker saved real progress under a revised contract, but HQ rejected it because three checkpoints from an older contract had consumed a lifetime task allowance. The worker prompt still invited a checkpoint after 45–60 minutes without exposing the remaining allowance.

Checkpoint allowance is now three per task generation. All attempts remain in request-wide execution accounting, with no budget increase. Prompts state used and remaining continuations. Fresh evidence is compared with the latest submitted work, including failed submissions, rather than an older successful checkpoint. A checkpoint still cannot approve a result, start downstream tasks, or skip checks and independent review.

Validation: TypeScript check and checkpoint integration tests cover bounded continuations in each generation, same-session recovery, downstream/review gates, stale evidence rejection, and displayed remaining allowance.

Runtime recovery: backed up the database while HQ was stopped; reran the full work-result judge against the sealed a14 commit and evidence relative to a13. It returned checkpoint with no rejection reasons. Recorded the previous verdict and correction in operator audit state, retained the original sealed result and complete attempt history, and resumed the same session. The request execution ceiling remains 140. This is recovery of unfinished work, not product acceptance.
