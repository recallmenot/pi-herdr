import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { herdr, type HerdrOpts } from "./herdr.js";
import type { Err, Result } from "./env.js";

export interface SpawnOrigin {
	readonly sessionId: string;
	readonly paneId?: string;
	readonly cwd: string;
	readonly sessionFile?: string;
}

const localSessionId = randomUUID();

export function captureSpawnOrigin(
	ctx?: Pick<ExtensionContext, "sessionManager" | "cwd">,
	env: Record<string, string | undefined> = process.env,
): SpawnOrigin {
	return {
		sessionId: ctx?.sessionManager?.getSessionId() ?? localSessionId,
		paneId: env.HERDR_PANE_ID,
		cwd: ctx?.cwd ?? process.cwd(),
		sessionFile: ctx?.sessionManager?.getSessionFile(),
	};
}

export type PlacementPlan =
	| { mode: "split"; targetPaneId?: string; direction: "right" | "down"; ratio: number }
	| { mode: "tab"; origin: SpawnOrigin; workspaceId: string };

export interface PaneRequest {
	plan: PlacementPlan;
	cwd: string;
	env: Record<string, string>;
	signal?: AbortSignal;
}

export type PaneAllocation =
	| { mode: "split"; paneId: string }
	| { mode: "tab"; paneId: string; tabId: string; workspaceId: string };

export type PlacementCommand = (args: string[], opts: HerdrOpts) => Promise<Result<unknown>>;

const Id = Type.String({ minLength: 1 });
const Pane = Type.Object({ pane_id: Id, tab_id: Id, workspace_id: Id });
const Tab = Type.Object({ tab_id: Id, workspace_id: Id });
const PaneInfo = Type.Object({ pane: Pane });
const TabInfo = Type.Object({ tab: Tab });
const TabCreated = Type.Object({ tab: Tab, root_pane: Pane });
const SplitCreated = Type.Object({ pane: Type.Object({ pane_id: Id }) });
const TabIdInfo = Type.Object({ tab: Type.Object({ tab_id: Id }) });
const RootPaneIdInfo = Type.Object({ root_pane: Type.Object({ pane_id: Id }) });

function failure(message: string, details?: unknown): Err {
	return { ok: false, error: { code: "VALIDATION_ERROR", message, details } };
}

function aborted(): Err {
	return { ok: false, error: { code: "TIMEOUT", message: "Worker pane allocation aborted or exceeded its 30s budget." } };
}

function phaseError(r: Err, phase: string, ids: { paneId?: string; tabId?: string; workspaceId?: string } = {}): Err {
	return {
		ok: false,
		error: {
			code: r.error.code,
			message: `Worker placement ${phase} failed: ${r.error.message}. No fallback to the orchestrator was attempted.`,
			details: { phase, ...ids },
		},
	};
}

function environmentArgs(cwd: string, env: Record<string, string>): string[] {
	return ["--cwd", cwd, ...Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`])];
}

interface WorkerGroup {
	tabId: string;
	panes: string[];
	ordinal: number;
}

type GroupState =
	| { kind: "ready"; group: WorkerGroup }
	| { kind: "uncertain"; error: Err };

interface OwnerSlot {
	tail: Promise<void>;
	state?: GroupState;
}

function waitForAllocationTurn(previous: Promise<void>, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const cancel = () => {
			signal.removeEventListener("abort", cancel);
			reject(new Error("aborted"));
		};
		if (signal.aborted) {
			cancel();
			return;
		}
		signal.addEventListener("abort", cancel, { once: true });
		previous.then(() => {
			signal.removeEventListener("abort", cancel);
			resolve();
		}, reject);
	});
}

export class WorkerPlacement {
	private readonly owners = new Map<string, OwnerSlot>();

	constructor(private readonly command: PlacementCommand = herdr) {}

	async resolveWorkspace(origin: SpawnOrigin, signal?: AbortSignal): Promise<Result<string>> {
		if (!origin.paneId) {
			return failure('worker_placement "tab" requires an originating Herdr pane. Start Pi inside Herdr or select "split".');
		}
		const r = await this.command(["pane", "get", origin.paneId], { timeoutMs: 10_000, signal });
		if (!r.ok) return phaseError(r, "source lookup", { paneId: origin.paneId });
		if (!Value.Check(PaneInfo, r.data) || r.data.pane.pane_id !== origin.paneId) {
			return failure("Herdr source lookup returned no authoritative pane/workspace membership.", {
				phase: "source lookup",
				paneId: origin.paneId,
			});
		}
		return { ok: true, data: r.data.pane.workspace_id };
	}

	async allocate(request: PaneRequest): Promise<Result<PaneAllocation>> {
		if (request.signal?.aborted) return aborted();
		if (request.plan.mode === "split") return this.split(request);
		const { origin, workspaceId } = request.plan;
		const key = JSON.stringify([origin.sessionId, origin.paneId, workspaceId]);
		let slot = this.owners.get(key);
		if (!slot) {
			slot = { tail: Promise.resolve() };
			this.owners.set(key, slot);
		}
		const previous = slot.tail;
		let release = () => {};
		const turn = new Promise<void>((resolve) => {
			release = resolve;
		});
		slot.tail = previous.then(() => turn);
		const controller = new AbortController();
		const cancel = () => controller.abort();
		request.signal?.addEventListener("abort", cancel, { once: true });
		const timer = setTimeout(cancel, 30_000);
		try {
			await waitForAllocationTurn(previous, controller.signal);
			if (controller.signal.aborted) return aborted();
			return await this.grouped(request, workspaceId, slot, controller.signal);
		} catch (e) {
			if (controller.signal.aborted) return aborted();
			return failure(`Worker pane allocation failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			clearTimeout(timer);
			request.signal?.removeEventListener("abort", cancel);
			release();
		}
	}

	private async split(request: PaneRequest): Promise<Result<PaneAllocation>> {
		if (request.plan.mode !== "split") return failure("Expected split placement.");
		const { targetPaneId, direction, ratio } = request.plan;
		const args = [
			"pane", "split", targetPaneId ? targetPaneId : "--current",
			"--direction", direction, "--ratio", String(ratio),
			...environmentArgs(request.cwd, request.env),
		];
		const r = await this.command(args, { timeoutMs: 20_000, signal: request.signal });
		if (!r.ok) return phaseError(r, "split");
		if (!Value.Check(SplitCreated, r.data)) return failure("Herdr pane split returned no pane ID.", { phase: "split" });
		return { ok: true, data: { mode: "split", paneId: r.data.pane.pane_id } };
	}

	private async grouped(
		request: PaneRequest,
		workspaceId: string,
		slot: OwnerSlot,
		signal: AbortSignal,
	): Promise<Result<PaneAllocation>> {
		if (slot.state?.kind === "uncertain") return slot.state.error;
		const group = slot.state?.group;
		if (!group) return this.createPane(request, workspaceId, slot, signal);

		const tab = await this.command(["tab", "get", group.tabId], { timeoutMs: 10_000, signal });
		if (!tab.ok) {
			if (tab.error.code === "NOT_FOUND") return this.createPane(request, workspaceId, slot, signal);
			return phaseError(tab, "group lookup", { tabId: group.tabId });
		}
		if (!Value.Check(TabInfo, tab.data) || tab.data.tab.tab_id !== group.tabId) {
			return failure("Herdr tab lookup returned malformed membership.", {
				phase: "group lookup",
				tabId: group.tabId,
			});
		}
		if (tab.data.tab.workspace_id !== workspaceId) {
			return this.createPane(request, workspaceId, slot, signal);
		}

		for (const target of [...group.panes].reverse()) {
			const pane = await this.command(["pane", "get", target], { timeoutMs: 10_000, signal });
			if (!pane.ok) {
				if (pane.error.code === "NOT_FOUND") continue;
				return phaseError(pane, "split target lookup", { tabId: group.tabId, paneId: target });
			}
			if (!Value.Check(PaneInfo, pane.data) || pane.data.pane.pane_id !== target) {
				return failure("Herdr pane lookup returned malformed membership.", {
					phase: "split target lookup",
					tabId: group.tabId,
					paneId: target,
				});
			}
			if (pane.data.pane.tab_id !== group.tabId ||
				pane.data.pane.workspace_id !== workspaceId) continue;
			return this.createPane(request, workspaceId, slot, signal, group, target);
		}
		return this.createPane(request, workspaceId, slot, signal);
	}

	private async createPane(
		request: PaneRequest,
		workspaceId: string,
		slot: OwnerSlot,
		signal: AbortSignal,
		group?: WorkerGroup,
		target?: string,
	): Promise<Result<PaneAllocation>> {
		if (signal.aborted) return aborted();
		let args: string[];
		if (group && target) {
			const direction = group.ordinal % 2 === 0 ? "right" : "down";
			args = ["pane", "split", target, "--direction", direction, "--ratio", "0.6"];
		} else {
			args = ["tab", "create", "--workspace", workspaceId, "--label", "Workers"];
		}
		args.push(...environmentArgs(request.cwd, request.env), "--no-focus");
		const r = await this.command(args, { timeoutMs: 20_000, signal });
		const ids: { workspaceId: string; tabId?: string; paneId?: string } = { workspaceId };
		if (group) ids.tabId = group.tabId;
		if (!r.ok) {
			const error = phaseError(r, group ? "pane creation" : "tab creation", ids);
			if (r.error.code === "TIMEOUT" || r.error.outcome === "unknown") return this.uncertain(slot, error, ids);
			return error;
		}
		if (Value.Check(TabIdInfo, r.data)) ids.tabId = r.data.tab.tab_id;
		if (Value.Check(SplitCreated, r.data)) ids.paneId = r.data.pane.pane_id;
		if (Value.Check(RootPaneIdInfo, r.data)) ids.paneId = r.data.root_pane.pane_id;
		let allocation: PaneAllocation;
		if (group) {
			if (!Value.Check(PaneInfo, r.data) ||
				r.data.pane.tab_id !== group.tabId ||
				r.data.pane.workspace_id !== workspaceId ||
				group.panes.includes(r.data.pane.pane_id)) {
				return this.uncertain(slot, failure("Herdr split response did not identify a distinct pane in the owned worker group."), ids);
			}
			allocation = { mode: "tab", paneId: r.data.pane.pane_id, tabId: group.tabId, workspaceId };
			group.panes.push(allocation.paneId);
			group.ordinal++;
		} else {
			if (!Value.Check(TabCreated, r.data) ||
				r.data.tab.workspace_id !== workspaceId ||
				r.data.root_pane.workspace_id !== workspaceId ||
				r.data.root_pane.tab_id !== r.data.tab.tab_id) {
				return this.uncertain(slot, failure("Herdr tab creation did not identify its root pane and expected workspace."), ids);
			}
			allocation = { mode: "tab", paneId: r.data.root_pane.pane_id, tabId: r.data.tab.tab_id, workspaceId };
			slot.state = { kind: "ready", group: { tabId: allocation.tabId, panes: [allocation.paneId], ordinal: 1 } };
		}
		return { ok: true, data: allocation };
	}

	private uncertain(slot: OwnerSlot, error: Err, ids: { paneId?: string; tabId?: string; workspaceId?: string }): Err {
		const refusal: Err = {
			ok: false,
			error: {
				code: error.error.code,
				message: `${error.error.message} Creation may have succeeded. Inspect Herdr before retrying; this owner/workspace will not create more panes until the extension reloads. Existing resources are left untouched.`,
				details: { phase: "allocation uncertain", ...ids },
			},
		};
		slot.state = { kind: "uncertain", error: refusal };
		return refusal;
	}
}

export const workerPlacement = new WorkerPlacement();
