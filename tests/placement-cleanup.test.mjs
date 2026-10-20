import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanupPlacementResources } from "./placement-cleanup.mjs";
import { collectPlacementState } from "./fixtures/placement-state.mjs";

test("live collection refreshes allocation and resume evidence without forgetting owned IDs", () => {
	const state = { panes: [], tabs: [], sessions: [] };
	const rec = { name: "worker", sessionPath: "session", origin: { sessionId: "owner" } };
	collectPlacementState(state, [rec]);
	rec.paneId = "first";
	rec.allocation = { paneId: "first", tabId: "group" };
	rec.launchPlan = ["initial"];
	collectPlacementState(state, [rec]);
	assert.equal(state.sessions[0].allocation.tabId, "group");
	rec.paneId = "resumed";
	rec.allocation = { paneId: "resumed", tabId: "new-group" };
	rec.launchPlan = ["fresh"];
	collectPlacementState(state, [rec]);
	assert.equal(state.sessions.length, 1);
	assert.deepEqual(state.sessions[0].plan, ["fresh"]);
	assert.equal(state.sessions[0].allocation.tabId, "new-group");
	assert.deepEqual(state.panes, ["first", "resumed"]);
	assert.deepEqual(state.tabs, ["group", "new-group"]);
});

function fixture() {
	const manifest = { panes: ["owned"], workspaces: ["sandbox"], worktrees: [{ path: "/tmp/placement-checkout", workspaceId: "sandbox", allowedFiles: ["result.txt"] }] };
	const panes = new Map([["owned", { pane_id: "owned", workspace_id: "sandbox", cwd: "/tmp/placement-checkout" }]]);
	const workspaces = new Map([["sandbox", { workspace_id: "sandbox", cwd: "/tmp/placement-project" }]]);
	const calls = [], removed = [];
	const deps = {
		command: async (args) => {
			calls.push(args);
			const [surface, action, id] = args;
			if (surface === "pane" && action === "get") return panes.has(id) ? { ok: true, data: { pane: panes.get(id) } } : { ok: false, error: { code: "NOT_FOUND" } };
			if (surface === "pane" && action === "close") { panes.delete(id); return { ok: true, data: {} }; }
			if (surface === "workspace" && action === "close") { workspaces.delete(id); return { ok: true, data: {} }; }
			if (surface === "api") return { ok: true, data: { snapshot: { panes: [...panes.values()], workspaces: [...workspaces.values()], tabs: [] } } };
			assert.fail(`Unexpected cleanup command ${args}`);
		},
		worktreeStatus: () => "?? result.txt\n",
		removeWorktree: (path) => removed.push(path),
	};
	return { manifest, deps, panes, workspaces, calls, removed };
}

test("cleanup removes only recorded panes, empty owned containers and known test artifacts", async () => {
	const f = fixture();
	await cleanupPlacementResources(f.manifest, f.deps);
	assert.deepEqual(f.removed, [f.manifest.worktrees[0].path]);
	assert(f.calls.filter((c) => c[1] === "close").every((c) => f.manifest.panes.includes(c[2]) || f.manifest.workspaces.includes(c[2])));
});

test("an unowned pane retains its workspace AND its worktree", async () => {
	const f = fixture();
	f.panes.set("user", { pane_id: "user", workspace_id: "sandbox", cwd: "/tmp/placement-checkout" });
	const notes = await cleanupPlacementResources(f.manifest, f.deps);
	assert.deepEqual(f.removed, []);
	assert(f.workspaces.has("sandbox"));
	assert(f.panes.has("user"));
	assert(notes.some((n) => n.includes("unowned pane")));
});

test("failed observation retains containers and checkouts rather than guessing absence", async () => {
	const f = fixture();
	f.deps.command = async () => ({ ok: false, error: { code: "TIMEOUT" } });
	await cleanupPlacementResources(f.manifest, f.deps);
	assert.deepEqual(f.removed, []);
	assert(f.workspaces.has("sandbox"));
});

test("a live external pane referencing a checkout prevents its removal", async () => {
	const f = fixture();
	f.panes.set("external", { pane_id: "external", workspace_id: "user-workspace", cwd: "/tmp/placement-checkout/nested" });
	await cleanupPlacementResources(f.manifest, f.deps);
	assert.deepEqual(f.removed, []);
	assert(f.panes.has("external"));
});

test("a moved pane and unowned checkout edits are retained", async () => {
	for (const kind of ["moved", "edits"]) {
		const f = fixture();
		if (kind === "moved") f.panes.get("owned").workspace_id = "outside";
		else f.deps.worktreeStatus = () => "?? user.txt\n";
		await cleanupPlacementResources(f.manifest, f.deps);
		assert.deepEqual(f.removed, []);
		if (kind === "moved") assert(f.panes.has("owned"));
	}
});
