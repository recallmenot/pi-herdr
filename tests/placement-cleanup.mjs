import { isAbsolute, relative } from "node:path";

export async function cleanupPlacementResources(manifest, deps) {
	const notes = [];
	let uncertain = false;
	const inspectSnapshot = async () => {
		const r = await deps.command(["api", "snapshot"]);
		if (!r.ok || !Array.isArray(r.data?.snapshot?.panes) || !Array.isArray(r.data?.snapshot?.workspaces)) throw new Error("Cleanup snapshot unavailable; resources retained");
		return r.data.snapshot;
	};
	for (const id of [...manifest.panes].reverse()) {
		try {
			const r = await deps.command(["pane", "get", id]);
			if (!r.ok && r.error.code === "NOT_FOUND") continue;
			if (!r.ok || r.data?.pane?.pane_id !== id) throw new Error(`Pane ${id} could not be observed`);
			if (!manifest.workspaces.includes(r.data.pane.workspace_id)) throw new Error(`Pane ${id} moved outside the owned workspace`);
			const closed = await deps.command(["pane", "close", id]);
			if (!closed.ok && closed.error.code !== "NOT_FOUND") throw new Error(`Pane ${id} close failed`);
		} catch (e) { uncertain = true; notes.push(`${e.message}; left untouched`); }
	}
	for (const id of [...manifest.workspaces].reverse()) {
		try {
			const s = await inspectSnapshot();
			if (!s.workspaces.some((w) => w.workspace_id === id)) continue;
			if (s.panes.some((p) => p.workspace_id === id && !manifest.panes.includes(p.pane_id))) throw new Error(`Workspace ${id} has an unowned pane`);
			const closed = await deps.command(["workspace", "close", id]);
			if (!closed.ok && closed.error.code !== "NOT_FOUND") throw new Error(`Workspace ${id} close failed`);
		} catch (e) { uncertain = true; notes.push(`${e.message}; left untouched`); }
	}
	for (const wt of manifest.worktrees) {
		try {
			if (uncertain) throw new Error("a pane or workspace was retained, or could not be observed");
			const s = await inspectSnapshot();
			const containers = [...s.panes, ...s.workspaces, ...(s.tabs ?? [])];
			if (containers.some((p) => {
				if (typeof p.cwd !== "string") return false;
				const rel = relative(wt.path, p.cwd);
				return !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\");
			}) || s.workspaces.some((w) => w.workspace_id === wt.workspaceId)) throw new Error("a live container still references the checkout");
			const changes = (await deps.worktreeStatus(wt.path)).trimEnd();
			if (changes && changes.split("\n").some((line) => !wt.allowedFiles?.includes(line.slice(3)))) throw new Error("the checkout has unowned edits");
			await deps.removeWorktree(wt.path);
			notes.push(`Removed test-created worktree ${wt.path}`);
		} catch (e) { notes.push(`Worktree ${wt.path} retained for inspection: ${e.message}`); }
	}
	return notes;
}
