# Dependency wakes and deliberate stops

A task can remain blocked after all recorded dependencies finish. Its assignee
may be waiting for an external action. Blocking its own task does not request
another dependency wake. The periodic recovery sweep preserves this decision,
including native status decisions attributed to the assignee's bound run.

Title, monitor, and other unrelated edits do not change this wait. A later
assignment, status, or blocker-set update permits reconciliation again. A blocker
that completes or finishes workspace export after the wait also permits a wake.
The export must name the blocker issue. An export from the waiting task or an
unattributed operation in the same shared workspace does not remove its wait.
Normal readiness, duplicate-wake, interaction, pause, and execution gates still
apply. A board transition into blocked keeps the existing recovery behavior.

A done blocker's workspace-finalize barrier reads the blocker's latest operation
on its execution workspace. A task created directly in `blocked` (never
transitioned into it) has no `blockedTransitionAt` stamp and joins the same
readiness, wake, and backstop paths as any other blocked dependent; creation
itself never suppresses the wake. A settled operation from a run that has ended
no longer holds dependents when that run recorded a successful
`workspace_finalize` for the blocker issue: the ended run can never write
another finalize, so the old rule held dependents forever with no path to
release them. Live runs keep the strict order; foreign-run operations,
unfinished operations, and failed finalizes with no later success still hold
dependents.

The periodic sweep logs one entry per skipped blocked candidate with a
`skipReason` (`not_ready`, `wake_already_emitted`, `self_blocked_by_assignee`,
`live_execution_path`, `pending_wake_interaction`, `pause_hold`) plus the
blocker, unresolved, and pending-finalize issue ids, so a stranded task is
visible in the server log even when every sweep only counts it.

A dependency completion can arrive while the assignee answers a question about
the blocked task. Its saved wake waits behind that turn. Deferred-receipt recovery
reconstructs these dependency wakes after the turn and its cleanup finish, even
when they contain no comment or interaction response. It uses the existing
release and dispatch checks; task cancellation, agent pause, and pending cleanup
still prevent execution.

Cancelling a run or pausing its agent suppresses immediate stranded-work recovery.
A queued user message remains a separate continuation request. The release path
still preserves independently authorized deferred input; stopping the old run
does not discard that input or grant permission to replay its old tools.
