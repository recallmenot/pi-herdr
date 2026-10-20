import assert from "node:assert/strict";
import { runtimeDetails } from "./placement-runtime.mjs";
import { collectPlacementState } from "./placement-state.mjs";
import { mkdirSync, writeFileSync, readFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import herdrExtension from "../../src/index.js";
import { spawnRecords, spawnAgent, captureSpawnOrigin } from "../../src/spawn.js";
import { herdr } from "../../src/herdr.js";
import { createWorktreeArgs, extractWorktree } from "../../src/tools/worktrees.js";
import { workflowRuns, stopAllWorkflowRuns } from "../../src/workflow/runs.js";
import { extractSessionResult } from "../../src/sessionfile.js";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default function placementDriver(pi) {
	const output = process.env.PI_HERDR_PLACEMENT_REPORT;
	if (!output) return;
	const root = process.env.PI_HERDR_PLACEMENT_ROOT;
	const project = process.env.PI_HERDR_PLACEMENT_PROJECT;
	const childArgs = ["-ne", "-e", join(root, "src/index.ts"), "-e", join(root, "tests/fixtures/placement-runtime.mjs")];
	const state = { panes: [], tabs: [], workspaces: [], worktrees: [], checks: [], notifications: [], sessions: [], finished: false };
	const tools = new Map();
	const forwarding = new Proxy(pi, {
		get(target, key) {
			if (key === "registerTool") return (tool) => { tools.set(tool.name, tool); return target.registerTool(tool); };
			return Reflect.get(target, key, target);
		},
	});
	herdrExtension(forwarding);
	const remember = (key, id) => { if (id && !state[key].includes(id)) state[key].push(id); };
	const collect = () => collectPlacementState(state, spawnRecords().values());
	const save = () => {
		collect();
		writeFileSync(`${output}.tmp`, JSON.stringify(state, null, 2));
		renameSync(`${output}.tmp`, output);
	};
	pi.on("input", (event) => {
		if (event.text.includes("<agent-message")) {
			state.notifications.push(event.text);
			save();
			return { action: "handled" };
		}
	});

	const runAcceptance = async (ctx) => {
			const timer = setInterval(save, 200);
			const controller = new AbortController();
			const deadline = setTimeout(() => controller.abort(), 10 * 60_000);
			const settingsFile = join(project, ".pi", "herdr.json");
			const setSettings = (extra = {}) => writeFileSync(settingsFile, JSON.stringify({ worker_placement: "tab", agents_kill_switch: false, max_parallel_agents: 3, max_spawn_depth: 2, workflows_enabled: true, notifications: "none", ...extra }));
			const call = async (name, params) => {
				const tool = tools.get(name);
				assert(tool, `missing tool ${name}`);
				const r = await tool.execute(`acceptance-${state.checks.length}`, params, controller.signal, () => {}, ctx);
				save();
				assert(!r.isError, `${name}: ${r.content.map((c) => c.text ?? "").join("\n")}`);
				return r.details;
			};
			const run = async (args) => {
				const r = await herdr(args, { timeoutMs: 30_000, signal: controller.signal });
				assert(r.ok, r.ok ? "" : r.error.message);
				return r.data;
			};
			const check = async (name, action) => { await action(); state.checks.push(name); save(); };
			const waitUntil = async (predicate, message, budget = 90_000) => {
				const until = Date.now() + budget;
				while (!controller.signal.aborted && Date.now() < until) {
					if (await predicate()) return;
					await pause(200);
				}
				throw new Error(message);
			};
			const fresh = (name, prompt, extra = {}) => call("herdr_spawn_agent", { name, prompt, agent: { name, kind: "pi", agent_args: childArgs }, ...extra });
			const readResult = (name) => call("herdr_get_agent_result", { target: name, wait: 90_000 });
			const close = async (name) => {
				const rec = spawnRecords().get(name);
				assert(rec?.paneId && state.panes.includes(rec.paneId));
				const live = await herdr(["pane", "get", rec.paneId], { timeoutMs: 10_000 });
				if (!live.ok && live.error.code === "NOT_FOUND") return;
				assert(live.ok);
				await run(["pane", "close", rec.paneId]);
			};
			try {
				setSettings();
				state.tools = pi.getAllTools().filter((t) => t.name.startsWith("herdr_")).map((t) => t.name).sort();
				assert.equal(state.tools.length, 12);
				state.runtime = runtimeDetails(pi);
				state.parent = { sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(), paneId: process.env.HERDR_PANE_ID, extension: join(root, "src/index.ts") };
				if (process.env.PI_HERDR_PLACEMENT_OWNER_ONLY === "1") {
					await check("a second real orchestrator keeps its worker group open in the same cwd", async () => {
						await fresh("live-other-owner", "Reply with exactly OTHER_ORCHESTRATOR. Do not use tools or agent_done. Remain available.", { agent: { name: "live-other-owner", kind: "pi", interactive: true, agent_args: childArgs } });
						assert.equal((await readResult("live-other-owner")).result.trim(), "OTHER_ORCHESTRATOR");
						const session = state.sessions[0];
						session.runtime = JSON.parse(readFileSync(`${session.path}.placement-runtime.json`, "utf8"));
						assert.deepEqual(session.runtime.tools, state.tools);
					});
					return;
				}
				const definitions = join(project, ".pi", "agents");
				mkdirSync(definitions, { recursive: true });
				writeFileSync(join(definitions, "general-purpose.md"), `---\nname: general-purpose\nkind: pi\nargs: ${JSON.stringify(childArgs)}\n---\nComplete only the supplied test task. Do not delegate.\n`);
				await check("concurrent real workers occupy one tab with distinct panes and exact retained results", async () => {
					const results = await Promise.all(["one", "two"].map((word) => fresh(`live-${word}`, `Reply with exactly PLACEMENT_${word.toUpperCase()}. Do not use tools.`)));
					assert.equal(new Set(results.map((r) => r.paneId)).size, 2);
					const records = ["live-one", "live-two"].map((n) => spawnRecords().get(n));
					assert.equal(records[0].allocation.tabId, records[1].allocation.tabId);
					for (const word of ["one", "two"]) {
						const result = await readResult(`live-${word}`);
						assert.equal(result.status, "done");
						assert.equal(result.result.trim(), `PLACEMENT_${word.toUpperCase()}`);
						assert.equal(result.result, extractSessionResult(spawnRecords().get(`live-${word}`).sessionPath).text);
					}
				});
				const draft = join(project, "review.md");
				const implementation = join(project, "implementation.txt");
				let persistentSession;
				await check("persistent worker drafts, explicitly notifies, revises, and waits for a separate implementation assignment", async () => {
					const result = await fresh("live-reviewer", `Write ${draft} with exactly DRAFT_REVISION_1. Then call herdr_message_agent targeting orchestrator with text containing the absolute file path and DRAFT_REVISION_1. Do not implement anything or call agent_done. End your turn and wait for further instructions.`, { agent: { name: "live-reviewer", kind: "pi", interactive: true, agent_args: childArgs } });
					persistentSession = result.sessionPath;
					await waitUntil(() => existsSync(draft) && readFileSync(draft, "utf8").trim() === "DRAFT_REVISION_1", "draft artifact missing");
					assert(!existsSync(implementation));
					await call("herdr_message_agent", { target: "live-reviewer", text: `Revise ${draft} to exactly DRAFT_REVISION_2. Notify orchestrator with its absolute path and DRAFT_REVISION_2. Do not implement or call agent_done. End your turn and wait.` });
					await waitUntil(() => readFileSync(draft, "utf8").trim() === "DRAFT_REVISION_2", "revision artifact missing");
					assert(!existsSync(implementation));
					await call("herdr_message_agent", { target: "live-reviewer", text: `DRAFT_REVISION_2 is approved. Separate implementation assignment: write ${implementation} with exactly IMPLEMENTED_REVISION_2. Notify orchestrator with its absolute path and IMPLEMENTED_REVISION_2. Do not call agent_done; remain available.` });
					await waitUntil(() => existsSync(implementation) && readFileSync(implementation, "utf8").trim() === "IMPLEMENTED_REVISION_2", "implementation artifact missing");
					await waitUntil(() => state.notifications.some((n) => n.includes("DRAFT_REVISION_1")) && state.notifications.some((n) => n.includes("DRAFT_REVISION_2")) && state.notifications.some((n) => n.includes("IMPLEMENTED_REVISION_2")), "parent did not observe all explicit notifications");
					assert.equal(spawnRecords().get("live-reviewer").sessionPath, persistentSession);
					assert(readFileSync(persistentSession, "utf8").includes("Separate implementation assignment"));
				});
				await check("retained interactive conversation resumes in a fresh grouped pane", async () => {
					const previousPane = spawnRecords().get("live-reviewer").paneId;
					await close("live-reviewer");
					const resumed = await call("herdr_resume_agent", { target: "live-reviewer", message: `Read ${draft} and reply with exactly RESUMED_REVISION_2. Remain available and do not call agent_done.` });
					assert.equal(resumed.sessionPath, persistentSession);
					assert.notEqual(resumed.paneId, previousPane);
					const result = await readResult("live-reviewer");
					assert.equal(result.result.trim(), "RESUMED_REVISION_2");
					assert.equal(spawnRecords().get("live-reviewer").allocation.mode, "tab");
				});
				await check("open interactive workers consume the existing cap and queued work drains into the group", async () => {
					setSettings({ max_parallel_agents: 1 });
					const queued = await fresh("live-queued", "Reply with exactly QUEUED_PLACEMENT. Do not use tools.");
					assert.equal(queued.queued, true);
					assert.equal(queued.paneId, undefined);
					await close("live-reviewer");
					const result = await readResult("live-queued");
					assert.equal(result.result.trim(), "QUEUED_PLACEMENT");
					assert.equal(spawnRecords().get("live-queued").allocation.mode, "tab");
					setSettings();
				});
				await check("scripted workflow children load this branch and follow the same placement policy", async () => {
					const workflow = await call("herdr_run_workflow", { script: 'export const meta = { name: "placement-live", description: "Worker placement acceptance" }; return await agent("Reply with exactly WORKFLOW_PLACEMENT. Do not use tools.", { label: "live-workflow" });' });
					state.workflowReceipt = workflow;
					await waitUntil(() => { const run = workflowRuns().get(workflow.runId); return run && run.status !== "running"; }, "workflow did not finish", 120_000);
					const run = workflowRuns().get(workflow.runId);
					assert.equal(run.result.status, "completed");
					assert(JSON.stringify(run.result).includes("WORKFLOW_PLACEMENT"));
					const rec = spawnRecords().get("live-workflow");
					assert.equal(rec.allocation.mode, "tab");
					assert(rec.launchPlan.includes(join(root, "src/index.ts")) && rec.launchPlan.includes("-ne"));
				});
				await check("isolated child keeps its worktree cwd and session binding without redirecting the group", async () => {
					const origin = captureSpawnOrigin(ctx);
					const reportFile = "isolated-result.txt";
					const isolated = await spawnAgent({ name: "live-isolated", prompt: `Use bash to write your exact current working directory to ${reportFile}, then reply with exactly ISOLATED_PLACEMENT. Do not delegate.`, isolated: true, agent: { kind: "pi", agent_args: childArgs } }, {
						origin, signal: controller.signal,
						parent: ctx.model ? { model: { provider: ctx.model.provider, id: ctx.model.id } } : undefined,
						registry: ctx.modelRegistry,
						worktree: async (cwd, opts) => {
							const r = await herdr(createWorktreeArgs({ cwd, focus: opts.focus }), { timeoutMs: 30_000, signal: controller.signal });
							if (!r.ok) return r;
							const wt = extractWorktree(r.data);
							assert(wt.path);
							const createdWorkspace = r.data.workspace;
							remember("workspaces", createdWorkspace?.workspace_id ?? wt.openWorkspaceId);
							remember("tabs", r.data.tab?.tab_id);
							remember("panes", r.data.root_pane?.pane_id);
							state.worktrees.push({ path: wt.path, workspaceId: createdWorkspace?.workspace_id ?? wt.openWorkspaceId, allowedFiles: [reportFile] });
							state.worktreeReceipt = r.data;
							save();
							return { ok: true, data: wt.path };
						},
					});
					save();
					assert(isolated.ok, isolated.ok ? "" : isolated.error.message);
					const result = await readResult("live-isolated");
					assert.equal(result.result.trim(), "ISOLATED_PLACEMENT");
					assert.equal(readFileSync(join(isolated.data.worktreePath, reportFile), "utf8").trim(), isolated.data.worktreePath);
					const rec = spawnRecords().get("live-isolated");
					assert.equal(rec.allocation.workspaceId, (await run(["pane", "get", process.env.HERDR_PANE_ID])).pane.workspace_id);
					const header = JSON.parse(readFileSync(rec.sessionPath, "utf8").split("\n")[0]);
					assert.equal(header.cwd, rec.worktreePath);
				});
				for (const session of state.sessions) {
					assert(session.plan.includes("-ne") && session.plan.includes(join(root, "src/index.ts")));
					assert(session.plan.includes(join(root, "src/child.ts")), "injected child extension remains loaded");
					session.runtime = JSON.parse(readFileSync(`${session.path}.placement-runtime.json`, "utf8"));
					assert.deepEqual(session.runtime.tools, state.tools, "each real child registers the same twelve branch tools");
				}
				state.deliveries = [...spawnRecords().values()].filter((r) => r.delivery).map((r) => ({ name: r.name, delivery: r.delivery }));
				assert(state.deliveries.some((r) => r.delivery.kind === "done"), "the shared production delivery loop supervises the driver's registry");
			} catch (e) { state.error = e.stack ?? String(e); controller.abort(); stopAllWorkflowRuns(); }
			finally {
				clearInterval(timer);
				clearTimeout(deadline);
				state.finished = true;
				save();
			}
	};
	pi.registerCommand("placement-acceptance", {
		description: "Run the sandboxed worker-placement acceptance checks.",
		handler: (_args, ctx) => { void runAcceptance(ctx); },
	});
}
