# Try worker tab placement

Use the local `feature/worker-tab-placement` branch. This is not a published
release or a claim of upstream approval. The default remains `"split"`.

## Run a manual trial without installing

1. Open a throwaway Herdr workspace and enter this checkout in its terminal.
2. Install dependencies and run the offline checks:

   ```bash
   npm ci
   npm run typecheck
   HERDR_BIN=/__offline_herdr_must_not_run__ npm test
   ```

3. Create a temporary project and a worker definition pinned to this checkout:

   ```bash
   checkout="$PWD"
   trial="$(mktemp -d)"
   mkdir -p "$trial/.pi/agents"
   cat > "$trial/.pi/herdr.json" <<'EOF'
   {
     "worker_placement": "tab",
     "agents_kill_switch": false,
     "max_parallel_agents": 3,
     "max_spawn_depth": 2
   }
   EOF
   cat > "$trial/.pi/agents/placement-reviewer.md" <<EOF
   ---
   name: placement-reviewer
   kind: pi
   interactive: true
   args: ["-ne", "-e", "$checkout/src/index.ts"]
   ---
   Handle only the assigned task. Do not delegate.
   EOF
   cd "$trial"
   pi -ne -e "$checkout/src/index.ts"
   ```

   Approve the temporary project's local configuration if Pi asks. Trial-local
   gates allow three workers without changing your global settings. Both parent
   and workers load the branch extension without an installed copy. Pi-herdr
   still injects its child extension and retained-session flags.

4. Ask Pi to spawn `type: "placement-reviewer"` with a short task. Expect a
   background `Workers` tab in the same workspace, with no change to your
   focused pane or the orchestrator tab's layout.
5. Start another worker of that type. Expect another pane in the same worker
   tab. `interactive: true` keeps both workers open after their turns.
6. In `/subagents config`, change `worker_placement` to `split`, then start
   another worker. Expect the existing split placement. Existing panes do not move.

The installed extension remains unchanged. Close only the trial-created panes
and tabs through Herdr's UI when finished. Keep the temporary project until no
worker uses it. Do not delete retained Pi sessions as placement cleanup.

### Exercise follow-ups and resume

1. Assign a draft artifact and ask the worker to notify `orchestrator` with its
   absolute path using `herdr_message_agent`.
2. Send a revision request to the same worker handle.
3. Inspect the revised artifact before sending a separate implementation task.
4. Close the worker pane, then use `herdr_resume_agent` with its registry handle
   and another assignment. Expect a fresh pane bound to the same session file.

Approval remains a task instruction. This feature adds no approval-enforcement
mechanism or new messaging protocol.

## Run the sandboxed live checks

From this checkout in a Herdr-managed pane, run these commands while the UI is
otherwise idle:

```bash
npm run test:placement:live
npm run test:placement:live -- --agents
```

The first command checks layout, ownership, cwd, environment, and focus without
model calls. The `--agents` run also uses your configured Pi model and credentials,
so it incurs model usage. It exercises two real orchestrators, persistent
workers, messaging, resume, queue draining, workflows, and an isolated checkout.
See [the verification record](worker-placement-verification.md) for coverage.

Each run prints the path to a temporary `report.json`. It records the tested
commit and dirty state, runtime versions, resource IDs, command traces, launch
plans, session paths, checks, focus events, and cleanup results. Children load
the branch explicitly. Their runtime receipts verify the same twelve Herdr
tools as the parent. The Pi executable on the npm script's PATH is reported
separately because it can differ from the daemon's agent runtime.

The harness subscribes to focus events before allocation. Switching focus
yourself during a run causes a focus assertion to fail.

### Inspect cleanup results

Cleanup uses only recorded resource IDs, not names or a fleet-wide sweep. A
user-added pane prevents whole-workspace cleanup. Failed observations, retained
containers, live checkout references, and unknown edits prevent worktree removal.
Read the report's `cleanup` entries after a failure before closing anything
manually. Reports, artifacts, and retained Pi session files are not deleted.

Read [ownership and failure handling](concepts.md#worker-placement-ownership)
for reload behavior and recovery after uncertain creation. Compatibility limits
are listed in [the verification record](worker-placement-verification.md).
