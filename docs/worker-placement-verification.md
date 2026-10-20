# Worker placement verification

## Review boundaries

The feature adds one internal pane allocator and the `worker_placement` setting.
The allocator owns session-scoped group membership and serializes allocation,
not agent attachment, boot, or execution. The existing launch and supervision
paths remain shared. No layout tools, per-spawn placement parameters, durable
registry, or new concurrency policy are added.

General startup fixes are separated from placement. Overlapping queue drains
and concurrent resumes must not launch the same record twice. Queue callbacks
must stop at session shutdown, and a failed prompt submission must not report
success. These fixes have standalone regressions in `tests/startup.mjs`.

Allocation-specific status and delivery changes stay with placement. Saving a
pane ID before attachment makes a shell visible to supervision before it is an
agent. Result polling and the watchdog must treat it as starting, while blocked
startup questions still wake the parent. Failed starts retain their allocated
panes and structured errors instead of closing a potentially occupied pane.

## Validation commands

Run the offline checks without allowing an uninjected command to reach Herdr:

```bash
npm run typecheck
HERDR_BIN=/__offline_herdr_must_not_run__ npm test
git diff --check
```

Run the focused live acceptance from a Herdr-managed pane:

```bash
npm run test:placement:live
npm run test:placement:live -- --agents
```

The [trial guide](worker-placement-trial.md) describes prerequisites and cleanup.
Each live report records its exact commit, dirty state, runtime versions,
command trace, resource manifest, results, and focus telemetry. Machine-local
reports and private session paths are not committed.

## Recorded result

Implementation revision `d0e7c91` was verified from a clean checkout on
2026-10-20. The prerequisite `e1897cd` also passed its full offline suite and
typecheck independently.

| Check | Result |
| --- | --- |
| Full sentinel offline suite | Passed, including 14 startup and 39 placement/cleanup tests |
| Typecheck and whitespace checks | Passed |
| Layout-only live acceptance | All 7 checks passed |
| Real-Pi live acceptance | All 8 outer checks and 7 main agent checks passed |
| Focus and source layout | Zero focus events; source layout unchanged in both runs |
| Cleanup | All recorded panes, tabs, workspaces, and isolated worktrees confirmed absent |

The exercised environment was Linux/x64, Node 26.8.2, Herdr 0.9.5, and actual
parent/worker Pi 1.1.0. The Pi executable on the npm harness PATH was 0.80.6;
it was recorded separately, not treated as the agent runtime. Parent and child
receipts confirmed the same twelve Herdr tools and explicit branch loading.
Local reports and retained sessions remain available to the operator but are
not portable PR evidence; the commands above reproduce the checks.

## Coverage

Offline tests exercise both placement policies, ownership across sessions and
workspaces, controlled concurrent allocations, cancellation, group loss,
malformed and wrong-ID responses, uncertain creation, startup inspection,
failed-start retention, queue draining, resume, and workflow integration.
Startup regressions include exhausted lost-turn retries and cancellation while
a timed-out submission awaits status reconciliation. Cleanup tests run
the actual manifest-based cleanup function against controlled observations.

Live acceptance checks the returned root pane, distinct grouped splits,
per-worker cwd and environment, rename and recreation, moved and user-added
panes, controlled rejection, and default split behavior. The real-agent run
also checks distinct groups for two orchestrators with the same cwd, persistent
draft and revision artifacts, explicit notifications, retained-session resume,
queue draining, workflow children, checkout isolation, and exact results.
Before/after layouts and focus events check that background starts preserve the
orchestrator's view. Runtime receipts verify branch loading in parent and child.

## Compatibility limits

Tab mode has been exercised on Linux with Herdr 0.9.5 and Pi 1.1.0. The global
Herdr minimum remains 0.9.0. Tab mode on Herdr 0.9.0, Windows, and macOS remains
unverified. A successful Linux run does not establish that compatibility.

Fork and lineage seeding, interruption, blocked states, and workflow cancellation
retain offline coverage, but this focused live command does not repeat every
historical live scenario. Same-pane session replacement and source-workspace
moves have deterministic coverage rather than separate real-agent live runs.

Ownership is ephemeral. Reload does not adopt old groups or reconstruct old
registry handles. See [ownership and failure handling](concepts.md#worker-placement-ownership)
for the runtime contract.
