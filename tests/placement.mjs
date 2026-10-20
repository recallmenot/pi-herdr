import assert from "node:assert/strict";
import { test, after } from "node:test";
import { createJiti } from "jiti";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url);
const spawn = await jiti.import(join(ROOT, "src/spawn.js"));
const { DEFAULT_SETTINGS } = await jiti.import(join(ROOT, "src/settings.js"));
const { resumeAgent } = await jiti.import(join(ROOT, "src/tools/lifecycle.js"));
const { deliverOnce, watchdogOnce } = await jiti.import(join(ROOT, "src/delivery.js"));
const { getAgentResult } = await jiti.import(join(ROOT, "src/tools/result.js"));
const { listAgentsView } = await jiti.import(join(ROOT, "src/tools/orchestration.js"));
const { fleetWidgetOnce } = await jiti.import(join(ROOT, "src/widget.js"));
const { projectStatus } = await jiti.import(join(ROOT, "src/status.js"));
const { createWorkflowHost } = await jiti.import(join(ROOT, "src/workflow/host.js"));
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const tmp = mkdtempSync(join(tmpdir(), "pi-herdr-placement-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const ok = (data) => ({ ok: true, data });
const error = (code = "VALIDATION_ERROR", message = "controlled failure") => ({ ok: false, error: { code, message } });
const deferred = () => {
	let resolve;
	const promise = new Promise((r) => { resolve = r; });
	return { promise, resolve };
};
const origin = (sessionId = "session-a", paneId = "source") => ({ sessionId, paneId, cwd: tmp });
const tabRequest = (owner = origin(), extra = {}) => ({
	plan: { mode: "tab", origin: owner, workspaceId: "workspace" }, cwd: tmp, env: {}, ...extra,
});
const flag = (args, name) => args[args.indexOf(name) + 1];

class FakeHerdr {
	calls = [];
	tabs = new Map([["source-tab", { tab_id: "source-tab", workspace_id: "workspace" }]]);
	panes = new Map([["source", { pane_id: "source", tab_id: "source-tab", workspace_id: "workspace" }]]);
	counter = 0;
	intercept;

	command = async (args, opts) => {
		this.calls.push([...args]);
		assert(opts.timeoutMs > 0 && opts.timeoutMs <= 30_000, "all placement commands are bounded");
		if (opts.signal?.aborted) return error("TIMEOUT", "aborted before dispatch");
		const intercepted = await this.intercept?.(args, opts);
		if (intercepted) return intercepted;
		const verb = args.slice(0, 2).join(" ");
		if (verb === "pane get") return this.panes.has(args[2]) ? ok({ pane: { ...this.panes.get(args[2]) } }) : error("NOT_FOUND");
		if (verb === "tab get") return this.tabs.has(args[2]) ? ok({ tab: { ...this.tabs.get(args[2]) } }) : error("NOT_FOUND");
		if (verb === "tab create") {
			const tab_id = `tab-${++this.counter}`;
			const pane_id = `root-${this.counter}`;
			const workspace_id = flag(args, "--workspace");
			const tab = { tab_id, workspace_id, label: flag(args, "--label") };
			const pane = { pane_id, tab_id, workspace_id };
			this.tabs.set(tab_id, tab);
			this.panes.set(pane_id, pane);
			return ok({ tab, root_pane: pane });
		}
		if (verb === "pane split") {
			const source = this.panes.get(args[2] === "--current" ? "source" : args[2]);
			assert(source, "split targets an existing explicit pane");
			const pane = { ...source, pane_id: `split-${++this.counter}` };
			this.panes.set(pane.pane_id, pane);
			return ok({ pane });
		}
		throw new Error(`Unexpected placement command ${verb}`);
	};

	creates() { return this.calls.filter((a) => a[1] === "create" || a[1] === "split"); }
}

function engine(over = {}) {
	spawn.clearSpawnRegistry();
	spawn.clearSessionAgents();
	const io = new FakeHerdr();
	const placement = new spawn.WorkerPlacement(io.command);
	let settings = { ...DEFAULT_SETTINGS, worker_placement: "tab" };
	let sequence = 0;
	const attachments = [];
	const prompts = [];
	const deps = {
		load: () => settings,
		origin: origin(),
		env: { HERDR_PANE_ID: "source" },
		placement,
		kinds: async () => ["pi", "claude"],
		list: async () => [],
		paneList: async () => [...io.panes.keys()],
		fleet: async () => ok([]),
		start: async (input) => { attachments.push(input); return ok({ agent: {} }); },
		boot: async () => ok(true),
		submit: async (paneId, text) => { prompts.push({ paneId, text }); return ok(true); },
		status: async () => ok("working"),
		seed: () => {
			const path = join(tmp, `session-${++sequence}.jsonl`);
			writeFileSync(path, "");
			return { path, dir: tmp };
		},
		autodrain: false,
		...over,
	};
	return { io, placement, deps, attachments, prompts, settings: (value) => { settings = { ...settings, ...value }; } };
}

const worker = (name, extra = {}) => ({ prompt: `task ${name}`, name, ...extra });

for (const mode of [undefined, "split"]) {
	test(`split mode ${mode ?? "default"} uses spiral panes without tab commands`, async () => {
		const h = engine();
		h.settings({ worker_placement: mode });
		for (const name of ["a", "b", "c"]) assert((await spawn.spawnAgent(worker(name), h.deps)).ok);
		const creates = h.io.creates();
		assert.deepEqual(creates.map((a) => a[2]), ["source", "split-1", "split-2"]);
		assert.deepEqual(creates.map((a) => flag(a, "--direction")), ["right", "down", "right"]);
		assert(creates.every((a) => flag(a, "--ratio") === "0.6"));
		assert(h.io.calls.every((a) => a[0] === "pane" && a[1] === "split"));
	});
}

test("first grouped worker uses the returned root; later workers have independent env and cwd", async () => {
	const h = engine();
	const a = await spawn.spawnAgent(worker("a", { cwd: join(tmp, "one"), extraEnv: { WORKFLOW_VALUE: "one" } }), h.deps);
	const b = await spawn.spawnAgent(worker("b", { cwd: join(tmp, "two"), extraEnv: { WORKFLOW_VALUE: "two" } }), h.deps);
	assert(a.ok && b.ok);
	assert.equal(a.data.paneId, "root-1");
	assert.equal(b.data.paneId, "split-2");
	assert.deepEqual(h.io.creates().map((a) => a.slice(0, 3)), [["tab", "create", "--workspace"], ["pane", "split", "root-1"]]);
	const [ca, cb] = h.io.creates();
	assert.equal(flag(ca, "--cwd"), join(tmp, "one"));
	assert.equal(flag(cb, "--cwd"), join(tmp, "two"));
	assert(ca.includes(`PI_HERDR_SESSION=${a.data.sessionPath}`));
	assert(cb.includes(`PI_HERDR_SESSION=${b.data.sessionPath}`));
	assert(!cb.includes(`PI_HERDR_SESSION=${a.data.sessionPath}`));
	assert(ca.includes("WORKFLOW_VALUE=one") && cb.includes("WORKFLOW_VALUE=two"));
	assert(ca.includes("PI_HERDR_ORCHESTRATOR_PANE=source"));
	assert(![...ca, ...cb].some((arg) => arg.startsWith("HERDR_PANE_ID=")));
	assert(h.io.creates().every((args) => args.includes("--no-focus") && !args.includes("--focus")));
	assert.equal(h.attachments[0].paneId, "root-1");
});

test("parallel first allocations share one tab and release the lock before agent boot", async () => {
	const h = engine();
	const entered = deferred(), creation = deferred(), boot = deferred(), bootEntered = deferred();
	h.io.intercept = async (args) => {
		if (args[0] === "tab" && args[1] === "create") { entered.resolve(); await creation.promise; }
	};
	const a = spawn.spawnAgent(worker("a"), { ...h.deps, boot: async () => { bootEntered.resolve(); await boot.promise; return ok(true); } });
	await entered.promise;
	const b = spawn.spawnAgent(worker("b"), h.deps);
	creation.resolve();
	await bootEntered.promise;
	const rb = await b;
	assert(rb.ok);
	assert.equal(h.io.calls.filter((a) => a[0] === "tab" && a[1] === "create").length, 1);
	assert.equal(rb.data.paneId, "split-2");
	boot.resolve();
	assert((await a).ok);
});

test("owners do not block or share groups, even in the same source pane and cwd", async () => {
	const io = new FakeHerdr();
	const placement = new spawn.WorkerPlacement(io.command);
	const entered = deferred(), release = deferred();
	let first = true;
	io.intercept = async (args) => {
		if (first && args[0] === "tab" && args[1] === "create") { first = false; entered.resolve(); await release.promise; }
	};
	const a = placement.allocate(tabRequest(origin("a")));
	await entered.promise;
	const b = await placement.allocate(tabRequest(origin("b")));
	assert(b.ok);
	release.resolve();
	const ra = await a;
	assert(ra.ok);
	assert.notEqual(ra.data.tabId, b.data.tabId);
	const c = await placement.allocate(tabRequest(origin("a", "other-source")));
	assert(c.ok && c.data.tabId !== ra.data.tabId);
});

test("cancelled waiters never allocate later and do not bypass a still-running predecessor", async () => {
	const io = new FakeHerdr(), placement = new spawn.WorkerPlacement(io.command);
	const entered = deferred(), release = deferred();
	let first = true;
	io.intercept = async (args) => {
		if (first && args[1] === "create") { first = false; entered.resolve(); await release.promise; }
	};
	const a = placement.allocate(tabRequest());
	await entered.promise;
	const cancel = new AbortController();
	const b = placement.allocate(tabRequest(origin(), { signal: cancel.signal }));
	cancel.abort();
	assert.equal((await b).error.code, "TIMEOUT");
	const c = placement.allocate(tabRequest());
	assert.equal(io.creates().length, 1);
	release.resolve();
	assert((await a).ok && (await c).ok);
	assert.equal(io.creates().length, 2);
});

test("definite creation rejection releases allocation; an uncertain create is never blindly retried", async () => {
	for (const code of ["VALIDATION_ERROR", "TIMEOUT"]) {
		const io = new FakeHerdr(), placement = new spawn.WorkerPlacement(io.command);
		let rejected = false;
		io.intercept = async (args) => {
			if (!rejected && args[1] === "create") { rejected = true; return error(code); }
		};
		const a = await placement.allocate(tabRequest());
		assert(!a.ok);
		const b = await placement.allocate(tabRequest());
		assert.equal(b.ok, code !== "TIMEOUT");
		assert.equal(io.creates().length, code === "TIMEOUT" ? 1 : 2);
		if (code === "TIMEOUT") assert.match(b.error.message, /may have succeeded/);
	}
});

test("malformed creation responses cannot be mistaken for a focused root or adopted later", async () => {
	for (const payload of [{ tab: { tab_id: "unknown", workspace_id: "workspace" } }, { id: "not-a-pane" }, { tab: { tab_id: "t", workspace_id: "elsewhere" }, root_pane: { pane_id: "p", tab_id: "t", workspace_id: "elsewhere" } }]) {
		const io = new FakeHerdr(), placement = new spawn.WorkerPlacement(io.command);
		io.intercept = async (args) => args[1] === "create" ? ok(payload) : undefined;
		assert(!(await placement.allocate(tabRequest())).ok);
		assert(!(await placement.allocate(tabRequest())).ok);
		assert.equal(io.creates().length, 1);
	}
});

test("renamed tabs retain ownership; removed or moved groups are not reclaimed", async () => {
	for (const change of ["rename", "close", "move", "move-owned-pane", "remove-owned-pane"]) {
		const io = new FakeHerdr(), placement = new spawn.WorkerPlacement(io.command);
		const first = (await placement.allocate(tabRequest())).data;
		io.panes.set("user-pane", { pane_id: "user-pane", tab_id: first.tabId, workspace_id: "workspace" });
		if (change === "rename") io.tabs.get(first.tabId).label = "My label";
		if (change === "close") { io.tabs.delete(first.tabId); io.panes.delete(first.paneId); }
		if (change === "move") io.tabs.get(first.tabId).workspace_id = "elsewhere";
		if (change === "move-owned-pane") io.panes.get(first.paneId).tab_id = "user-tab";
		if (change === "remove-owned-pane") io.panes.delete(first.paneId);
		const second = await placement.allocate(tabRequest());
		assert(second.ok);
		assert.equal(second.data.tabId === first.tabId, change === "rename");
		assert(io.creates().every((a) => a[2] !== "user-pane"));
		assert(!io.calls.some((a) => a.includes("close") || a.includes("move")));
	}
});

test("pre-cancelled allocations make no commands", async () => {
	const io = new FakeHerdr(), placement = new spawn.WorkerPlacement(io.command);
	const controller = new AbortController();
	controller.abort();
	assert.equal((await placement.allocate(tabRequest(origin(), { signal: controller.signal }))).error.code, "TIMEOUT");
	assert.deepEqual(io.calls, []);
});

test("source workspace changes get independent groups without moving previous workers", async () => {
	const io = new FakeHerdr(), placement = new spawn.WorkerPlacement(io.command);
	const a = await placement.allocate(tabRequest());
	const b = await placement.allocate({ ...tabRequest(), plan: { ...tabRequest().plan, workspaceId: "second" } });
	assert(a.ok && b.ok && a.data.tabId !== b.data.tabId);
	const back = await placement.allocate(tabRequest());
	assert(back.ok && back.data.tabId === a.data.tabId);
	assert.equal(io.tabs.get(a.data.tabId).workspace_id, "workspace");
});

test("malformed successful observations fail without creating a group", async () => {
	for (const target of ["tab", "pane"]) {
		const io = new FakeHerdr(), placement = new spawn.WorkerPlacement(io.command);
		await placement.allocate(tabRequest());
		io.intercept = async (args) => args[0] === target && args[1] === "get" ? ok({}) : undefined;
		assert(!(await placement.allocate(tabRequest())).ok);
		assert.equal(io.creates().length, 1);
	}
});

for (const target of ["tab", "pane"]) {
	test(`wrong-ID ${target} observations fail without creating a replacement`, async () => {
		const io = new FakeHerdr(), placement = new spawn.WorkerPlacement(io.command);
		const first = await placement.allocate(tabRequest());
		io.intercept = async (args) => {
			if (args[0] !== target || args[1] !== "get") return;
			return target === "tab"
				? ok({ tab: { tab_id: "unrelated-tab", workspace_id: "workspace" } })
				: ok({ pane: { pane_id: "unrelated-pane", tab_id: first.data.tabId, workspace_id: "workspace" } });
		};
		const result = await placement.allocate(tabRequest());
		assert.equal(result.ok, false, "a different resource ID is not evidence of absence or a move");
		assert.equal(result.error.details.phase, target === "tab" ? "group lookup" : "split target lookup");
		assert.equal(io.creates().length, 1);
		io.intercept = undefined;
		const next = await placement.allocate(tabRequest());
		assert(next.ok);
		assert.equal(next.data.tabId, first.data.tabId, "a valid observation reuses the original group");
	});
}

test("observation failure is not absence and never creates a replacement", async () => {
	for (const target of ["tab", "pane"]) {
		const io = new FakeHerdr(), placement = new spawn.WorkerPlacement(io.command);
		await placement.allocate(tabRequest());
		io.intercept = async (args) => args[0] === target && args[1] === "get" ? error("TIMEOUT") : undefined;
		assert(!(await placement.allocate(tabRequest())).ok);
		assert.equal(io.creates().length, 1);
		io.intercept = undefined;
		assert((await placement.allocate(tabRequest())).ok);
		assert.equal(io.creates().length, 2);
	}
});

test("tab mode refuses a missing origin before worktree or pane side effects", async () => {
	const h = engine({ origin: origin("outside", undefined) });
	h.deps.origin = { sessionId: "outside", cwd: tmp };
	h.deps.worktree = async () => { assert.fail("must resolve source before worktree"); };
	const r = await spawn.spawnAgent(worker("outside", { isolated: true }), h.deps);
	assert(!r.ok && /originating Herdr pane/.test(r.error.message));
	assert.equal(h.io.creates().length, 0);
});

test("workspace is resolved before isolated worktree creation and final cwd seeds the session", async () => {
	const h = engine();
	let options;
	h.deps.worktree = async (cwd, opts) => {
		assert.deepEqual(h.io.calls[0], ["pane", "get", "source"]);
		assert.equal(cwd, tmp);
		options = opts;
		h.io.panes.get("source").workspace_id = "changed-ambient-workspace";
		return ok(join(tmp, "checkout"));
	};
	const r = await spawn.spawnAgent(worker("isolated", { isolated: true }), h.deps);
	assert(r.ok);
	assert.equal(options.focus, false);
	assert.equal(flag(h.io.creates()[0], "--workspace"), "workspace");
	assert.equal(flag(h.io.creates()[0], "--cwd"), join(tmp, "checkout"));
	assert.equal(spawn.spawnRecords().get("isolated").worktreePath, join(tmp, "checkout"));
});

test("queued starts retain origin and parent session but read placement when they actually start", async () => {
	const h = engine();
	h.settings({ worker_placement: "split", max_parallel_agents: 1 });
	const first = await spawn.spawnAgent(worker("active"), h.deps);
	h.deps.list = async () => [{ paneId: first.data.paneId }];
	const parentFile = join(tmp, "parent.jsonl");
	writeFileSync(parentFile, JSON.stringify({ type: "session", version: 3, id: "parent", cwd: tmp }) + "\n");
	const acceptedOrigin = { ...origin(), sessionFile: parentFile };
	const queued = await spawn.spawnAgent(worker("queued", { agent: { session_mode: "lineage-only" } }), { ...h.deps, origin: acceptedOrigin });
	assert(queued.ok && queued.data.queued);
	h.settings({ worker_placement: "tab" });
	const drain = { ...h.deps, list: async () => [], origin: origin("other-session"), parentSession: "wrong.jsonl" };
	assert.equal(await spawn.drainQueueOnce(drain), 1);
	const rec = spawn.spawnRecords().get("queued");
	assert.equal(rec.origin.sessionId, "session-a");
	assert.equal(rec.allocation.mode, "tab");
	assert.equal(JSON.parse(readFileSync(rec.sessionPath, "utf8").split("\n")[0]).parentSession, parentFile);
	assert(h.io.creates().at(-1).includes("PI_HERDR_ORCHESTRATOR_PANE=source"));
});

test("resume uses current placement and retains origin, session, and isolated checkout", async () => {
	const h = engine();
	const first = await spawn.spawnAgent(worker("resume-me", { agent: { interactive: true } }), h.deps);
	assert(first.ok);
	const rec = spawn.spawnRecords().get("resume-me");
	rec.isolated = true;
	rec.worktreePath = join(tmp, "retained-checkout");
	h.io.tabs.delete(rec.allocation.tabId);
	h.io.panes.delete(rec.paneId);
	h.deps.worktree = async () => { assert.fail("resume must not create another worktree"); };
	const resumed = await resumeAgent({ target: "resume-me", message: "revision two" }, { ...h.deps, origin: origin("new-current-session") });
	assert(resumed.ok);
	assert.equal(resumed.data.sessionPath, first.data.sessionPath);
	assert.equal(rec.origin.sessionId, "session-a");
	assert.equal(rec.allocation.mode, "tab");
	assert.equal(flag(h.io.creates().at(-1), "--cwd"), rec.worktreePath);
	assert.equal(h.prompts.at(-1).text, "revision two");
});

test("mode changes do not move old panes or split a grouped predecessor", async () => {
	const h = engine();
	const grouped = await spawn.spawnAgent(worker("grouped"), h.deps);
	h.settings({ worker_placement: "split" });
	const split = await spawn.spawnAgent(worker("split"), h.deps);
	assert(grouped.ok && split.ok);
	assert.equal(h.io.creates().at(-1)[2], "source");
	assert.equal(h.io.panes.get(grouped.data.paneId).tab_id, "tab-1");
	assert(!h.io.calls.some((a) => a[1] === "move" || a[1] === "close"));
});

for (const phase of ["attachment", "boot", "submission"]) {
	test(`failed ${phase} retains the allocated pane and never closes it during delivery`, async () => {
		const h = engine();
		if (phase === "attachment") h.deps.start = async () => error("AGENT_START_FAILED");
		if (phase === "boot") h.deps.boot = async () => error("TIMEOUT");
		if (phase === "submission") { h.deps.submit = async () => error("TIMEOUT"); h.deps.status = async () => ok("idle"); }
		const r = await spawn.spawnAgent(worker("failed"), h.deps);
		assert(!r.ok);
		assert.equal(r.error.details.phase, phase);
		assert.equal(r.error.details.paneId, "root-1");
		const rec = spawn.spawnRecords().get("failed");
		assert.equal(rec.paneId, "root-1");
		assert(rec.startError);
		assert.equal(await spawn.drainQueueOnce(h.deps), 0);
		const closes = [];
		await deliverOnce({ registry: spawn.spawnRecords, fleet: ok([{ paneId: rec.paneId, agentStatus: "working" }]), load: h.deps.load, readSidecar: () => ({ state: "missing" }), readTakeover: () => ({ taken: false }), closePane: async (id) => closes.push(id) });
		await deliverOnce({ registry: spawn.spawnRecords, fleet: ok([]), load: h.deps.load, closePane: async (id) => closes.push(id) });
		assert.deepEqual(closes, []);
	});
}

test("non-Pi agents use the same grouped allocator without a Pi session contract", async () => {
	const h = engine({ seed: () => assert.fail("non-pi must not seed a Pi session") });
	const r = await spawn.spawnAgent(worker("nonpi", { agent: { kind: "claude" } }), h.deps);
	assert(r.ok);
	assert.equal(h.attachments[0].agent, "claude");
	assert.equal(r.data.paneId, "root-1");
	assert.equal(r.data.sessionPath, undefined);
});

test("unsaved host sessions have distinct stable identities, independent of cwd", () => {
	const manager = SessionManager.inMemory(tmp);
	const ctx = { sessionManager: manager, cwd: tmp };
	const a = spawn.captureSpawnOrigin(ctx, { HERDR_PANE_ID: "source" });
	assert.equal(a.sessionFile, undefined);
	assert.equal(spawn.captureSpawnOrigin(ctx, {}).sessionId, a.sessionId);
	manager.newSession();
	assert.notEqual(spawn.captureSpawnOrigin(ctx, {}).sessionId, a.sessionId);
});

test("workflow spawn and resume snapshot parent identity and use the shared placement path", async () => {
	const h = engine();
	const manager = SessionManager.inMemory(tmp);
	const captured = manager.getSessionId();
	const seen = [];
	const host = createWorkflowHost({
		pi: {}, runId: "wf_placement", ctx: { sessionManager: manager, cwd: tmp },
		spawn: async (params, deps) => {
			seen.push(deps.origin);
			assert.equal(params.workflow, "wf_placement");
			return spawn.spawnAgent(params, { ...h.deps, origin: { ...deps.origin, paneId: "source" } });
		},
		resume: async (params, deps) => {
			seen.push(deps.origin);
			return resumeAgent(params, { ...h.deps, origin: deps.origin });
		},
		result: async () => ok({ status: "done", result: "exact result" }),
	});
	manager.newSession();
	const a = await host.spawnAgent({ agentId: "one", label: "workflow-a", prompt: "draft" });
	assert(a.ok);
	const rec = spawn.spawnRecords().get("workflow-a");
	assert.equal(rec.origin.sessionId, captured);
	assert.equal(rec.allocation.mode, "tab");
	assert.equal(rec.workflow, "wf_placement");
	const b = await host.resumeAgent("one", "revise");
	assert(b.ok);
	assert(seen.every((o) => o.sessionId === captured));
	assert.equal(h.io.creates().length, 2);
});

test("an allocated shell remains starting, cannot resume, and never causes a false watchdog ping", async () => {
	const entered = deferred(), release = deferred();
	const h = engine({ start: async () => { entered.resolve(); await release.promise; return ok(true); } });
	const pending = spawn.spawnAgent(worker("held"), h.deps);
	await entered.promise;
	const rec = spawn.spawnRecords().get("held");
	try {
		const deps = { registry: spawn.spawnRecords, status: async () => error("NOT_FOUND"), readSidecar: () => ({ state: "missing" }), extract: () => null };
		assert.equal((await getAgentResult({ target: "held" }, deps)).data.status, "starting");
		assert.equal(await spawn.currentStatus(rec, { status: deps.status }), "working");
		const pings = [];
		await watchdogOnce({ registry: spawn.spawnRecords, fleet: ok([]), push: (p) => pings.push(p) });
		assert.deepEqual(pings, []);
		const fleetView = await listAgentsView({ registry: spawn.spawnRecords, list: async () => ok([]), readSidecar: deps.readSidecar });
		assert.equal(fleetView.data.rows[0].state, "starting");
		const widgets = [];
		await fleetWidgetOnce({ registry: spawn.spawnRecords, fleet: ok([]), liveRuns: () => [], readSidecar: deps.readSidecar,
			ui: { setWidget: (_key, factory) => { if (factory) widgets.push(factory(null, { fg: (_color, text) => text, inverse: (text) => text })); } },
		});
		assert.match(widgets[0].render(120).join("\n"), /starting/);
		assert.doesNotMatch(widgets[0].render(120).join("\n"), /stalled/);
		assert.equal(projectStatus(rec, { starting: true, absent: true, unhealthy: false, sidecar: true, activity: { state: "missing" }, now: 1 }).status, "finalizing");
		const blocked = { registry: spawn.spawnRecords, fleet: ok([{ paneId: rec.paneId, agentStatus: "blocked" }]), push: (p) => pings.push(p), readSidecar: deps.readSidecar, readTakeover: () => ({ taken: false }) };
		await deliverOnce(blocked);
		assert.equal(pings[0].details.kind, "blocked", "startup questions still wake the parent");
		await deliverOnce({ ...blocked, fleet: ok([{ paneId: rec.paneId, agentStatus: "idle" }]) });
		await deliverOnce(blocked);
		assert.equal(pings.length, 2, "an observed idle re-arms the next blocked startup question");
		const resumed = await resumeAgent({ target: "held" }, h.deps);
		assert(!resumed.ok && /still starting/.test(resumed.error.message));
		assert.equal(rec.paneId, "root-1");
		const waiting = getAgentResult({ target: "held", wait: true }, { ...deps,
			status: async () => spawn.isRecordStarting(rec) ? error("NOT_FOUND") : ok("done"),
			sleep: async () => { release.resolve(); await pending; },
		});
		assert.equal((await waiting).data.status, "done");
	} finally { release.resolve(); await pending; }
});

test("split predecessor selection happens after slow worktree creation", async () => {
	const h = engine();
	h.settings({ worker_placement: "split" });
	const first = await spawn.spawnAgent(worker("first"), h.deps);
	h.deps.worktree = async () => { h.io.panes.delete(first.data.paneId); return ok(join(tmp, "new-checkout")); };
	assert((await spawn.spawnAgent(worker("second", { isolated: true }), h.deps)).ok);
	assert.equal(h.io.creates().at(-1)[2], "source");
});

test("source lookup must identify the captured pane, not just some workspace", async () => {
	const h = engine();
	h.io.intercept = async () => ok({ pane: { pane_id: "wrong", tab_id: "source-tab", workspace_id: "workspace" } });
	assert(!(await h.placement.resolveWorkspace(origin())).ok);
	assert.equal(h.io.creates().length, 0);
});

test("parse failures after dispatch freeze creation just like a lost response", async () => {
	const io = new FakeHerdr(), placement = new spawn.WorkerPlacement(io.command);
	io.intercept = async (args) => args[1] === "create" ? { ok: false, error: { code: "VALIDATION_ERROR", outcome: "unknown", message: "herdr returned unparseable output" } } : undefined;
	assert(!(await placement.allocate(tabRequest())).ok);
	io.intercept = undefined;
	assert(!(await placement.allocate(tabRequest())).ok);
	assert.equal(io.creates().length, 1);
	const transport = await jiti.import(join(ROOT, "src/herdr.js"));
	const bin = process.env.HERDR_BIN;
	try {
		process.env.HERDR_BIN = process.execPath;
		const parsed = await transport.herdr(["-e", "process.stdout.write('{truncated')"], { skipFloorGate: true });
		assert(!parsed.ok && parsed.error.outcome === "unknown");
		const rejection = await transport.herdr(["-e", "console.log(JSON.stringify({error:{code:'invalid_target',message:'rejected'}}))"], { skipFloorGate: true });
		assert(!rejection.ok && rejection.error.outcome === "rejected");
	} finally { if (bin === undefined) delete process.env.HERDR_BIN; else process.env.HERDR_BIN = bin; }
});

test("partial allocation IDs survive spawn, queued inspection, and resume errors", async () => {
	const malformed = ok({ tab: { tab_id: "known-tab" }, root_pane: { pane_id: "known-root" } });
	const h = engine();
	h.io.intercept = async (args) => args[1] === "create" ? malformed : undefined;
	const result = await spawn.spawnAgent(worker("partial"), h.deps);
	assert(!result.ok);
	assert.equal(result.error.details.paneId, "known-root");
	assert.equal(result.error.details.tabId, "known-tab");
	const view = await getAgentResult({ target: "partial" });
	assert.equal(view.data.lastKnown.startFailure.details.paneId, "known-root");
	const other = engine();
	assert((await spawn.spawnAgent(worker("resume"), other.deps)).ok);
	other.io.tabs.clear();
	other.io.intercept = async (args) => args[1] === "create" ? malformed : undefined;
	const resumed = await resumeAgent({ target: "resume" }, other.deps);
	assert(!resumed.ok);
	assert.equal(resumed.error.details.paneId, "known-root");
});

test("resume cannot carry an old pending-close into a retained failed-start pane", async () => {
	const h = engine();
	assert((await spawn.spawnAgent(worker("close-race"), h.deps)).ok);
	const rec = spawn.spawnRecords().get("close-race"), closed = [];
	const deliveryDeps = { registry: spawn.spawnRecords, load: h.deps.load, push() {}, closePane: async (id) => closed.push(id), readTakeover: () => ({ taken: false }), extract: () => null };
	await deliverOnce({ ...deliveryDeps, fleet: ok([{ paneId: rec.paneId, agentStatus: "working" }]), readSidecar: () => ({ state: "ok", sidecar: { type: "done" } }) });
	h.deps.start = async () => error("AGENT_START_FAILED");
	assert(!(await resumeAgent({ target: "close-race", message: "new task" }, h.deps)).ok);
	const retained = { ...deliveryDeps, fleet: ok([]), readSidecar: () => ({ state: "missing" }) };
	await deliverOnce(retained);
	await deliverOnce(retained);
	assert.deepEqual(closed, []);
	rec.paneClosePending = true;
	await deliverOnce(retained);
	assert.deepEqual(closed, [], "even a late stale close flag cannot close a retained start-error pane");
});

test("session shutdown cancels queued ownership and stale drain callbacks", async () => {
	const h = engine();
	h.settings({ max_parallel_agents: 1 });
	const live = await spawn.spawnAgent(worker("live"), h.deps);
	await spawn.spawnAgent(worker("queued"), { ...h.deps, autodrain: true, list: async () => [{ paneId: live.data.paneId }] });
	const entered = deferred(), fleet = deferred();
	const draining = spawn.drainQueueOnce({ ...h.deps, list: async () => { entered.resolve(); return fleet.promise; } });
	await entered.promise;
	const extension = (await jiti.import(join(ROOT, "src/index.js"))).default;
	const hooks = new Map(), notes = [];
	extension({ registerTool() {}, registerCommand() {}, on: (name, fn) => { if (!hooks.has(name)) hooks.set(name, []); hooks.get(name).push(fn); }, events: { on() {} } });
	for (const fn of hooks.get("session_shutdown")) await fn({}, { ui: { notify: (note) => notes.push(note) } });
	fleet.resolve([]);
	assert.equal(await draining, 0);
	assert.equal(await spawn.drainQueueOnce(h.deps), 0);
	assert.equal(spawn.spawnRecords().get("queued").startFailure.details.phase, "queue shutdown");
	assert.equal(h.io.creates().length, 1);
	assert.match(notes[0], /1 queued/);
});
