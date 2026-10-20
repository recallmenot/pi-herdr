import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import net from "node:net";
import { cleanupPlacementResources } from "./placement-cleanup.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url);
const { herdr } = await jiti.import(join(ROOT, "src/herdr.js"));
const { WorkerPlacement } = await jiti.import(join(ROOT, "src/placement.js"));
const agents = process.argv.includes("--agents");
if (process.env.HERDR_ENV !== "1") throw new Error("Run this test from a Herdr-managed pane. It never targets the focused pane implicitly.");
const dir = mkdtempSync(join(tmpdir(), "pi-herdr-placement-live-"));
const project = join(dir, "project");
mkdirSync(project);
const reportPath = join(dir, "report.json");
const manifest = { workspaces: [], tabs: [], panes: [], worktrees: [] };
const report = { knownGaps: ["Herdr 0.9.0 and Windows/macOS have not been exercised by this branch.", "Fork/lineage, interruption, blocked states and workflow abort are covered offline but not all repeated in this focused live run."], versions: {}, commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(), dirty: execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim() !== "", manifest, checks: [], focusEvents: [], trace: [], cleanup: [] };
let events;
let closingFocus = false;
let parentPane;
let workspaceId;
let rootPane;
let baseline;
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
const remember = (kind, id) => { if (id && !manifest[kind].includes(id)) manifest[kind].push(id); save(); };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(args, timeoutMs = 20_000) {
	report.trace.push(args);
	const r = await herdr(args, { timeoutMs });
	save();
	assert(r.ok, `${args.slice(0, 3).join(" ")}: ${r.ok ? "" : r.error.message}`);
	return r.data;
}
const snapshot = async () => (await run(["api", "snapshot"])).snapshot;
function created(data) {
	remember("workspaces", data.workspace?.workspace_id);
	remember("tabs", data.tab?.tab_id);
	remember("panes", data.root_pane?.pane_id ?? data.pane?.pane_id);
	return data;
}
async function allocate(allocator, origin, extra = {}) {
	const source = await allocator.resolveWorkspace(origin);
	assert(source.ok, source.ok ? "" : source.error.message);
	const r = await allocator.allocate({ plan: { mode: "tab", origin, workspaceId: source.data }, cwd: project, env: {}, ...extra });
	if (!r.ok) {
		remember("tabs", r.error.details?.tabId);
		remember("panes", r.error.details?.paneId);
	}
	assert(r.ok, r.ok ? "" : r.error.message);
	remember("tabs", r.data.tabId);
	remember("panes", r.data.paneId);
	return r.data;
}
async function check(name, action) {
	try {
		await action();
		report.checks.push({ name, result: "PASS" });
		console.log(`PASS ${name}`);
	} catch (e) {
		report.checks.push({ name, result: "FAIL", error: String(e) });
		throw e;
	} finally { save(); }
}
function focusOf(s) { return [s.focused_workspace_id, s.focused_tab_id, s.focused_pane_id]; }
async function stable() {
	const current = await snapshot();
	assert.deepEqual(focusOf(current), focusOf(baseline), "keyboard focus, active tab and workspace remain unchanged");
	assert.deepEqual(current.layouts.find((l) => l.tab_id === rootPane.tab_id), baseline.layouts.find((l) => l.tab_id === rootPane.tab_id), "the source tab's full split tree, geometry and zoom remain unchanged");
	assert.equal(current.workspaces.find((w) => w.workspace_id === workspaceId)?.active_tab_id, rootPane.tab_id, "the background source workspace keeps its active tab");
	assert.deepEqual(report.focusEvents, [], "no transient focus events during background placement");
	assert.equal(report.focusTelemetryError, undefined, "focus telemetry remained connected");
}

async function subscribeFocus() {
	const socketPath = process.env.HERDR_SOCKET_PATH;
	assert(socketPath, "HERDR_SOCKET_PATH is required to observe transient focus events");
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		let buffer = "", ready = false;
		const timer = setTimeout(() => { socket.destroy(); reject(new Error("focus subscription handshake timed out")); }, 5_000);
		socket.on("connect", () => socket.write(JSON.stringify({ id: "placement-focus", method: "events.subscribe", params: { subscriptions: [{ type: "workspace.focused" }, { type: "tab.focused" }, { type: "pane.focused" }] } }) + "\n"));
		socket.on("data", (chunk) => {
			buffer += chunk;
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const message = JSON.parse(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
				if (!ready && message.id === "placement-focus") {
					clearTimeout(timer);
					if (message.error) { socket.destroy(); reject(new Error(message.error.message)); return; }
					ready = true;
					resolve(socket);
				} else if (message.event) { report.focusEvents.push(message); save(); }
			}
		});
		socket.on("error", (e) => { clearTimeout(timer); if (!ready) reject(e); else report.focusTelemetryError = e.message; });
		socket.on("close", () => {
			if (!ready) reject(new Error("focus subscription closed before acknowledgement"));
			else if (!closingFocus) { report.focusTelemetryError = "focus subscription closed during acceptance"; save(); }
		});
	});
}

async function closeOwnedPane(id) {
	if (!manifest.panes.includes(id)) throw new Error(`Refusing unowned pane ${id}`);
	const r = await herdr(["pane", "get", id], { timeoutMs: 10_000 });
	if (!r.ok && r.error.code === "NOT_FOUND") return;
	assert(r.ok, "failed pane observation is not absence evidence");
	assert(manifest.workspaces.includes(r.data.pane.workspace_id), `Pane ${id} moved outside the test workspace; leaving it untouched`);
	await run(["pane", "close", id]);
}

async function agentAcceptance() {
	const settingsDir = join(project, ".pi");
	mkdirSync(settingsDir, { recursive: true });
	writeFileSync(join(settingsDir, "herdr.json"), JSON.stringify({ worker_placement: "tab", agents_kill_switch: false, max_parallel_agents: 3, max_spawn_depth: 2, workflows_enabled: true, notifications: "normal" }));
	execFileSync("git", ["init", "-q"], { cwd: project });
	execFileSync("git", ["-c", "user.name=Placement Test", "-c", "user.email=placement@example.invalid", "commit", "--allow-empty", "-qm", "Placement fixture"], { cwd: project });
	const driverPath = join(ROOT, "tests/fixtures/placement-driver.mjs");
	const env = ["--env", `PI_HERDR_PLACEMENT_REPORT=${join(dir, "agents.json")}`, "--env", `PI_HERDR_PLACEMENT_ROOT=${ROOT}`, "--env", `PI_HERDR_PLACEMENT_PROJECT=${project}`];
	const otherFile = join(dir, "other-orchestrator.json");
	const other = created(await run(["tab", "create", "--workspace", workspaceId, "--cwd", project, "--label", "Other placement parent", ...env, "--env", `PI_HERDR_PLACEMENT_REPORT=${otherFile}`, "--env", "PI_HERDR_PLACEMENT_OWNER_ONLY=1", "--no-focus"]));
	await run(["agent", "start", `placement-other-${Date.now().toString(36)}`, "--kind", "pi", "--pane", other.root_pane.pane_id, "--", "-ne", "-e", driverPath, "--session", join(dir, "other-parent.jsonl")], 45_000);
	await run(["agent", "prompt", other.root_pane.pane_id, "/placement-acceptance"], 15_000);
	const otherDeadline = Date.now() + 120_000;
	while (Date.now() < otherDeadline) {
		if (existsSync(otherFile)) {
			const result = JSON.parse(readFileSync(otherFile, "utf8"));
			report.otherOrchestrator = result;
			for (const id of result.panes) remember("panes", id);
			for (const id of result.tabs) remember("tabs", id);
			if (result.finished) { assert.equal(result.error, undefined, result.error); break; }
		}
		await pause(300);
	}
	assert(report.otherOrchestrator?.finished, "the second orchestrator did not finish its start");
	const parent = created(await run(["tab", "create", "--workspace", workspaceId, "--cwd", project, "--label", "Placement parent", ...env, "--no-focus"]));
	parentPane = parent.root_pane.pane_id;
	const parentSession = join(dir, "parent.jsonl");
	writeFileSync(parentSession, "");
	await run(["agent", "start", `placement-${Date.now().toString(36)}`, "--kind", "pi", "--pane", parentPane, "--", "-ne", "-e", driverPath, "--session", parentSession], 45_000);
	await run(["agent", "prompt", parentPane, "/placement-acceptance"], 15_000);
	const deadline = Date.now() + 12 * 60_000;
	let done = false;
	while (Date.now() < deadline) {
		const file = join(dir, "agents.json");
		if (existsSync(file)) {
			const result = JSON.parse(readFileSync(file, "utf8"));
			report.agents = result;
			for (const id of result.panes ?? []) remember("panes", id);
			for (const id of result.tabs ?? []) remember("tabs", id);
			for (const ws of result.workspaces ?? []) remember("workspaces", ws);
			for (const wt of result.worktrees ?? []) if (!manifest.worktrees.some((w) => w.path === wt.path)) manifest.worktrees.push(wt);
			if (result.finished) { done = true; assert.equal(result.error, undefined, result.error); break; }
		}
		await pause(300);
	}
	assert(done, "real-agent acceptance exceeded its twelve-minute budget; inspect agents.json and manifest");
	const one = report.agents.sessions[0], two = report.otherOrchestrator.sessions[0];
	assert.equal(one.origin.cwd, two.origin.cwd);
	assert.notEqual(one.origin.sessionId, two.origin.sessionId);
	assert.notEqual(one.origin.paneId, two.origin.paneId);
	assert.notEqual(one.allocation.tabId, two.allocation.tabId);
	report.agents.checks.push("two real orchestrators with the same cwd have distinct worker groups");
	await stable();
}

async function cleanup() {
	if (parentPane) await herdr(["pane", "send-keys", parentPane, "esc"], { timeoutMs: 10_000 });
	report.cleanup.push(...await cleanupPlacementResources(manifest, {
		command: (args) => herdr(args, { timeoutMs: 15_000 }),
		worktreeStatus: (path) => execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: path, encoding: "utf8" }),
		removeWorktree: (path) => execFileSync("git", ["worktree", "remove", "--force", path], { cwd: project }),
	}));
	save();
}

try {
	report.versions = { node: process.version, platform: `${process.platform}/${process.arch}`, herdr: execFileSync(process.env.HERDR_BIN ?? "herdr", ["--version"], { encoding: "utf8" }).trim(), piOnHarnessPath: execFileSync("pi", ["--version"], { encoding: "utf8" }).trim() };
	events = await subscribeFocus();
	const workspace = created(await run(["workspace", "create", "--cwd", project, "--label", "Placement acceptance", "--no-focus"]));
	workspaceId = workspace.workspace.workspace_id;
	rootPane = workspace.root_pane;
	baseline = await snapshot();
	report.before = baseline;
	const owner = { sessionId: `placement-${Date.now()}`, paneId: rootPane.pane_id, cwd: project };
	const allocator = new WorkerPlacement(async (args, opts) => { report.trace.push(args); save(); return herdr(args, opts); });
	let first;
	await check("root allocation, background focus events and unchanged source layout", async () => {
		first = await allocate(allocator, owner, { env: { PLACEMENT_MARKER: "root", PLACEMENT_ROOT_ONLY: "must-not-leak" } });
		const s = await snapshot();
		assert.equal(s.tabs.find((t) => t.tab_id === first.tabId).pane_count, 1);
		assert.equal(s.panes.find((p) => p.pane_id === first.paneId).tab_id, first.tabId);
		await stable();
	});
	await check("parallel allocations share a tab and reserve distinct owned panes", async () => {
		const children = await Promise.all(["a", "b", "c"].map((value) => allocate(allocator, owner, { env: { PLACEMENT_MARKER: value } })));
		assert(children.every((p) => p.tabId === first.tabId));
		assert.equal(new Set(children.map((p) => p.paneId)).size, 3);
		const output = join(dir, "environment.txt");
		const command = `node -e ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({marker:process.env.PLACEMENT_MARKER,rootOnly:process.env.PLACEMENT_ROOT_ONLY,pane:process.env.HERDR_PANE_ID,cwd:process.cwd()}))`)}`;
		await run(["pane", "run", children[0].paneId, command]);
		const deadline = Date.now() + 10_000;
		while (!existsSync(output) && Date.now() < deadline) await pause(100);
		const env = JSON.parse(readFileSync(output, "utf8"));
		assert.equal(env.marker, "a");
		assert.equal(env.rootOnly, undefined, "tab root environment must not leak to later children");
		assert.equal(env.pane, children[0].paneId);
		assert.equal(env.cwd, project);
		await stable();
	});
	await check("renamed group reuses IDs; a second session in the same pane gets a separate group", async () => {
		await run(["tab", "rename", first.tabId, "Renamed worker group"]);
		assert.equal((await allocate(allocator, owner)).tabId, first.tabId);
		assert.notEqual((await allocate(allocator, { ...owner, sessionId: `${owner.sessionId}-second` })).tabId, first.tabId);
		await stable();
	});
	await check("closed last worker pane removes its tab and the next start recreates it", async () => {
		const isolatedOwner = { ...owner, sessionId: `${owner.sessionId}-closed` };
		const a = await allocate(allocator, isolatedOwner);
		await closeOwnedPane(a.paneId);
		const gone = await herdr(["tab", "get", a.tabId], { timeoutMs: 10_000 });
		assert(!gone.ok && gone.error.code === "NOT_FOUND");
		const b = await allocate(allocator, isolatedOwner);
		assert.notEqual(b.tabId, a.tabId);
		await stable();
	});
	await check("a moved owned pane and a user-added pane are never adopted as split targets", async () => {
		const movedOwner = { ...owner, sessionId: `${owner.sessionId}-moved` };
		const a = await allocate(allocator, movedOwner);
		const unrelated = created(await run(["pane", "split", a.paneId, "--direction", "right", "--cwd", project, "--no-focus"]));
		const destination = created(await run(["tab", "create", "--workspace", workspaceId, "--cwd", project, "--no-focus"]));
		await run(["pane", "move", a.paneId, "--tab", destination.tab.tab_id, "--target-pane", destination.root_pane.pane_id, "--split", "right", "--no-focus"]);
		const b = await allocate(allocator, movedOwner);
		assert.notEqual(b.tabId, a.tabId);
		assert((await run(["pane", "get", unrelated.pane.pane_id])).pane.tab_id === a.tabId);
		await stable();
	});
	await check("controlled allocation rejection does not split the source and allows the next attempt", async () => {
		let fail = true;
		const rejecting = new WorkerPlacement(async (args, opts) => {
			if (fail && args[0] === "tab" && args[1] === "create") { fail = false; return { ok: false, error: { code: "VALIDATION_ERROR", message: "controlled rejection before dispatch" } }; }
			return herdr(args, opts);
		});
		const request = { plan: { mode: "tab", origin: owner, workspaceId }, cwd: project, env: {} };
		assert(!(await rejecting.allocate(request)).ok);
		await allocate(rejecting, owner);
		await stable();
	});
	await check("default split policy targets only the explicit sandbox source", async () => {
		const a = await allocator.allocate({ plan: { mode: "split", targetPaneId: rootPane.pane_id, direction: "right", ratio: 0.6 }, cwd: project, env: {} });
		assert(a.ok);
		remember("panes", a.data.paneId);
		assert.equal((await run(["pane", "get", a.data.paneId])).pane.tab_id, rootPane.tab_id);
		await closeOwnedPane(a.data.paneId);
		await stable();
	});
	if (agents) await check("real branch-loaded parent, persistent review, queue, resume, workflow and isolated worker", agentAcceptance);
	else report.knownGaps.push("Real-agent session, messaging, queue, resume, workflow and worktree acceptance requires --agents.");
	report.after = await snapshot();
} catch (e) {
	report.error = e.stack ?? String(e);
	process.exitCode = 1;
	console.error(report.error);
} finally {
	closingFocus = true;
	events?.destroy();
	await cleanup().catch((e) => { report.cleanup.push(String(e)); process.exitCode = 1; });
	save();
	console.log(`Placement evidence and exact resource manifest: ${reportPath}`);
}
