import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const lifecycle = await jiti.import("../src/tools/lifecycle.ts");
const { getAgentResult } = await jiti.import("../src/tools/result.ts");
const spawn = await jiti.import("../src/spawn.js");
const { DEFAULT_SETTINGS } = await jiti.import("../src/settings.ts");
const ok = (data) => ({ ok: true, data });
const fail = (code, message, details) => ({ ok: false, error: { code, message, details } });
function deferred() {
	let resolve;
	const promise = new Promise((r) => { resolve = r; });
	return { promise, resolve };
}
function record(over = {}) {
	return {
		name: "blocker", kind: "claude", prompt: "work", agentArgs: [], depth: 2,
		isolated: false, spawnedAt: 1, submitted: false, sawWorking: false,
		stance: "interactive", origin: { sessionId: "startup-test", cwd: process.cwd() }, ...over,
	};
}
function harness(over = {}) {
	const starts = [];
	const submissions = [];
	const deps = {
		load: () => ({ ...DEFAULT_SETTINGS, max_parallel_agents: 1 }),
		kinds: async () => ["pi", "claude"],
		list: async () => [],
		paneList: async () => [],
		origin: { sessionId: "startup-test", cwd: process.cwd() },
		placement: { allocate: async () => ok({ mode: "split", paneId: "w1:p2" }) },
		start: async (input) => { starts.push(input); return ok(true); },
		boot: async () => ok(true),
		submit: async (id, text) => { submissions.push({ id, text }); return ok(true); },
		status: async () => ok("working"),
		env: {}, autodrain: false,
		...over,
	};
	return { deps, starts, submissions };
}
async function acceptQueued(deps, name = "queued") {
	const blocker = record({ paneId: "w1:p1" });
	spawn.putSpawnRecordForTests(blocker);
	const accepted = await spawn.spawnAgent(
		{ name, prompt: "do queued work", agent: { name, kind: "claude" } },
		{ ...deps, list: async () => [{ name: blocker.name, paneId: blocker.paneId }] },
	);
	assert.equal(accepted.ok, true);
	assert.equal(accepted.data.queued, true);
	return spawn.spawnRecords().get(accepted.data.name);
}

await test("overlapping starts share one handoff and completed records never start twice", async () => {
	spawn.clearSpawnRegistry();
	const entered = deferred();
	const release = deferred();
	const h = harness({ start: async (input) => {
		h.starts.push(input);
		entered.resolve();
		return release.promise;
	} });
	const rec = await acceptQueued(h.deps);
	const first = spawn.startRecordNow(rec, h.deps);
	await entered.promise;
	const second = spawn.startRecordNow(rec, h.deps);
	release.resolve(ok(true));
	const results = await Promise.all([first, second]);
	assert(results.every((r) => r.ok && r.data.paneId === "w1:p2"));
	assert.equal(h.starts.length, 1, "only one pane is created for an accepted record");
	assert.equal(h.submissions.length, 1, "the prompt is handed off once");
	assert.deepEqual(await spawn.startRecordNow(rec, h.deps), results[0]);
	assert.equal(h.starts.length, 1, "a completed start is idempotent");
});

await test("overlapping queue snapshots recheck records after list returns", async () => {
	spawn.clearSpawnRegistry();
	const lists = [deferred(), deferred()];
	let reads = 0;
	const h = harness({ list: () => lists[reads++].promise });
	await acceptQueued(h.deps);
	const first = spawn.drainQueueOnce(h.deps);
	const stale = spawn.drainQueueOnce(h.deps);
	lists[0].resolve([]);
	assert.equal(await first, 1);
	lists[1].resolve([]);
	assert.equal(await stale, 0, "stale queued snapshot does not restart a completed record");
	assert.equal(h.starts.length, 1);
	assert.equal(h.submissions.length, 1);
});

await test("a drain skips records whose direct start is in flight", async () => {
	spawn.clearSpawnRegistry();
	const entered = deferred();
	const release = deferred();
	const h = harness({ start: async (input) => {
		h.starts.push(input);
		entered.resolve();
		return release.promise;
	} });
	const rec = await acceptQueued(h.deps);
	const starting = spawn.startRecordNow(rec, h.deps);
	await entered.promise;
	const drain = spawn.drainQueueOnce(h.deps);
	release.resolve(ok(true));
	assert.equal((await starting).ok, true);
	assert.equal(await drain, 0);
	assert.equal(h.starts.length, 1);
});

await test("failed and thrown starts stay inspectable and cannot be retried by a stale drain", async () => {
	for (const throws of [false, true]) {
		spawn.clearSpawnRegistry();
		const failure = fail("AGENT_START_FAILED", "attachment refused", { reason: "busy" });
		const h = harness({ start: async (input) => {
			h.starts.push(input);
			if (throws) throw new Error("start seam threw");
			return failure;
		} });
		const rec = await acceptQueued(h.deps);
		assert.equal(await spawn.drainQueueOnce(h.deps), 0);
		assert.match(rec.startError, throws ? /start seam threw/ : /attachment refused/);
		assert.equal(rec.startFailure.code, "AGENT_START_FAILED");
		if (!throws) {
			assert.equal(rec.startFailure.code, failure.error.code);
			assert.match(rec.startFailure.message, /attachment refused/);
			assert.equal(rec.startFailure.details.phase, "attachment");
		}
		assert.equal(await spawn.currentStatus(rec, h.deps), "gone");
		const inspected = await getAgentResult({ target: rec.name, wait: true });
		assert.equal(inspected.ok, true);
		assert.equal(inspected.data.status, "gone");
		assert.match(inspected.data.note, throws ? /start seam threw/ : /attachment refused/);
		assert.deepEqual(await spawn.startRecordNow(rec, h.deps), { ok: false, error: rec.startFailure });
		assert.equal(await spawn.drainQueueOnce(h.deps), 0);
		assert.equal(h.starts.length, 1);
	}
});

await test("overlapping callers await boot failure even after a pane is attached", async () => {
	spawn.clearSpawnRegistry();
	const entered = deferred();
	const boot = deferred();
	const h = harness({ boot: () => { entered.resolve(); return boot.promise; } });
	const rec = await acceptQueued(h.deps);
	const first = spawn.startRecordNow(rec, h.deps);
	await entered.promise;
	const second = spawn.startRecordNow(rec, h.deps);
	boot.resolve(fail("TIMEOUT", "boot timed out"));
	const [failed, duplicate] = await Promise.all([first, second]);
	assert.equal(failed.ok, false);
	assert.deepEqual(duplicate, failed, "having a pane does not make an unfinished start successful");
	assert.equal(rec.paneId, "w1:p2", "the failed pane remains addressable");
	assert.deepEqual(await spawn.startRecordNow(rec, h.deps), failed, "a retained pane cannot hide a start failure");
	assert.equal(h.starts.length, 1);
	assert.equal(h.submissions.length, 0);
});

await test("queued starts retain the accepting caller's cancellation signal", async () => {
	spawn.clearSpawnRegistry();
	const controller = new AbortController();
	const h = harness({ signal: controller.signal });
	const rec = await acceptQueued(h.deps);
	controller.abort();
	assert.equal(await spawn.drainQueueOnce(h.deps), 0);
	assert.equal(h.starts.length, 0, "cancelled accepted work creates no pane");
	assert.equal(rec.startFailure.code, "TIMEOUT");
	assert.equal(await spawn.currentStatus(rec, h.deps), "gone");
});

await test("prompt failures are not hidden by an unrelated working status", async () => {
	spawn.clearSpawnRegistry();
	const h = harness({ submit: async () => fail("VALIDATION_ERROR", "input rejected") });
	const result = await spawn.spawnAgent(
		{ name: "reject", prompt: "work", agent: { name: "reject", kind: "claude" } }, h.deps,
	);
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "VALIDATION_ERROR");
	assert.match(result.error.message, /input rejected/);
	assert.equal(result.error.details.paneId, "w1:p2");
	const rec = spawn.spawnRecords().get("reject");
	assert.equal(rec.submitted, false);
	assert.match(rec.startError, /input rejected/);
	assert.deepEqual((await spawn.startRecordNow(rec, h.deps)).error, rec.startFailure);
	assert.equal(h.starts.length, 1);
});

await test("a submission timeout succeeds only with live working or blocked evidence", async () => {
	for (const status of ["working", "blocked", "idle", "done", "unknown", null]) {
		spawn.clearSpawnRegistry();
		const h = harness({
			submit: async () => fail("TIMEOUT", "settle timed out"),
			status: async () => status === null ? fail("NOT_FOUND", "no agent") : ok(status),
		});
		const result = await spawn.spawnAgent(
			{ name: "timeout", prompt: "work", agent: { name: "timeout", kind: "claude" } }, h.deps,
		);
		const delivered = status === "working" || status === "blocked";
		assert.equal(result.ok, delivered, `timeout with ${status} observation`);
		assert.equal(spawn.spawnRecords().get("timeout").submitted, delivered);
		if (!delivered) {
			assert.equal(result.error.code, "TIMEOUT");
			assert.equal(result.error.details.paneId, "w1:p2");
		}
	}
});

await test("NOT_STARTED retries once and never reports two lost turns as submitted", async () => {
	for (const succeeds of [true, false]) {
		spawn.clearSpawnRegistry();
		let attempts = 0;
		const h = harness({
			submit: async () => ++attempts === 2 && succeeds ? ok(true) : fail("TIMEOUT", "NOT_STARTED"),
			status: async () => ok(succeeds ? "idle" : "working"),
		});
		const result = await spawn.spawnAgent(
			{ name: "retry", prompt: "work", agent: { name: "retry", kind: "claude" } }, h.deps,
		);
		assert.equal(attempts, 2);
		assert.equal(result.ok, succeeds);
		assert.equal(spawn.spawnRecords().get("retry").submitted, succeeds);
	}
});

await test("cancellation during timeout reconciliation cannot claim successful handoff", async () => {
	for (const status of ["working", "blocked"]) {
		spawn.clearSpawnRegistry();
		const controller = new AbortController();
		const entered = deferred(), observed = deferred();
		const h = harness({
			signal: controller.signal,
			submit: async () => fail("TIMEOUT", "settle timed out"),
			status: () => { entered.resolve(); return observed.promise; },
		});
		const pending = spawn.spawnAgent(
			{ name: "reconcile-abort", prompt: "work", agent: { name: "reconcile-abort", kind: "claude" } }, h.deps,
		);
		await entered.promise;
		controller.abort();
		observed.resolve(ok(status));
		const result = await pending;
		assert.equal(result.ok, false, `cancelled while awaiting ${status} observation`);
		assert.equal(result.error.code, "TIMEOUT");
		assert.equal(spawn.spawnRecords().get("reconcile-abort").submitted, false);
	}
});

await test("an aborted submission cannot claim success from working status", async () => {
	spawn.clearSpawnRegistry();
	const controller = new AbortController();
	const h = harness({ signal: controller.signal, submit: async () => {
		controller.abort();
		return fail("TIMEOUT", "submission aborted");
	} });
	const result = await spawn.spawnAgent(
		{ name: "aborted", prompt: "work", agent: { name: "aborted", kind: "claude" } }, h.deps,
	);
	assert.equal(result.ok, false);
	assert.equal(spawn.spawnRecords().get("aborted").submitted, false);
});

await test("resume claims the record before fleet observation and releases the claim on failure", async () => {
	spawn.clearSpawnRegistry();
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-startup-"));
	try {
		const sessionPath = join(dir, "retained.jsonl");
		writeFileSync(sessionPath, "");
		const rec = record({ name: "resume", kind: "pi", paneId: "w1:old", sessionPath,
			definition: { name: "resume", kind: "pi" }, startError: "old failure",
			startFailure: { code: "AGENT_START_FAILED", message: "old failure" } });
		spawn.putSpawnRecordForTests(rec);
		const fleet = deferred();
		let fleetReads = 0;
		const h = harness({ fleet: () => { fleetReads++; return fleet.promise; } });
		const first = lifecycle.resumeAgent({ target: rec.name, message: "first" }, h.deps);
		const second = lifecycle.resumeAgent({ target: rec.name, message: "second" }, h.deps);
		fleet.resolve(fail("TIMEOUT", "fleet unavailable"));
		const [failed, duplicate] = await Promise.all([first, second]);
		assert.equal(failed.ok, false);
		assert.equal(duplicate.ok, false);
		assert.equal(duplicate.error.code, "VALIDATION_ERROR");
		assert.equal(fleetReads, 1, "duplicate resume is refused before awaiting fleet");
		assert.equal(rec.prompt, "work", "refused resumes do not overwrite the task");
		const secondFleet = deferred();
		const nextDeps = { ...h.deps, fleet: () => secondFleet.promise };
		const retry = lifecycle.resumeAgent({ target: rec.name, message: "retry" }, nextDeps);
		const duplicateRetry = lifecycle.resumeAgent({ target: rec.name, message: "overwrite" }, nextDeps);
		secondFleet.resolve(ok([]));
		const [resumed, refused] = await Promise.all([retry, duplicateRetry]);
		assert.equal(resumed.ok, true, "a later resume can claim after observation failure");
		assert.equal(refused.ok, false, "only one concurrent resume can relaunch the retained session");
		assert.equal(rec.startFailure, undefined, "resume clears the failed attempt");
		assert.equal(h.starts.length, 1);
		assert.deepEqual(h.submissions, [{ id: "w1:p2", text: "retry" }]);
		assert.equal(rec.sessionPath, sessionPath);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

await test("resume refuses an in-flight start even when fleet has not detected its pane", async () => {
	spawn.clearSpawnRegistry();
	const dir = mkdtempSync(join(tmpdir(), "pi-herdr-startup-"));
	try {
		const sessionPath = join(dir, "retained.jsonl");
		writeFileSync(sessionPath, "");
		for (const resumeFirst of [false, true]) {
			const rec = record({ name: "booting", kind: "pi", sessionPath, definition: { name: "booting", kind: "pi" } });
			spawn.putSpawnRecordForTests(rec);
			const boot = deferred();
			const entered = deferred();
			const fleet = deferred();
			const h = harness({ boot: () => { entered.resolve(); return boot.promise; }, fleet: () => fleet.promise });
			const resuming = resumeFirst
				? lifecycle.resumeAgent({ target: rec.name, message: "duplicate" }, h.deps)
				: null;
			const starting = spawn.startRecordNow(rec, h.deps);
			await entered.promise;
			const resumed = resuming ?? lifecycle.resumeAgent({ target: rec.name, message: "duplicate" }, h.deps);
			fleet.resolve(ok([]));
			boot.resolve(ok(true));
			assert.equal((await starting).ok, true);
			assert.equal((await resumed).ok, false, "resume rechecks a start begun during fleet observation");
			assert.equal(h.starts.length, 1);
			assert.deepEqual(h.submissions, [{ id: "w1:p2", text: "work" }]);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

await test("shutdown cancels queued records and stale drain callbacks without rearming", async (t) => {
	spawn.clearSpawnRegistry();
	const entered = deferred();
	const active = harness({ boot: (_paneId, _budget, signal) => new Promise((resolve) => {
		entered.resolve();
		signal.addEventListener("abort", () => resolve(fail("TIMEOUT", "boot aborted")), { once: true });
	}) });
	const booting = await acceptQueued(active.deps, "booting-shutdown");
	const starting = spawn.drainQueueOnce(active.deps);
	await entered.promise;
	const list = deferred();
	let reads = 0;
	const h = harness({ autodrain: true, list: () => { reads++; return list.promise; } });
	const queued = await acceptQueued({ ...h.deps, autodrain: false });
	const waiting = spawn.drainQueueOnce(h.deps);
	t.mock.timers.enable({ apis: ["setTimeout"] });
	spawn.ensureDrainLoop(h.deps);
	t.mock.timers.tick(3_000);
	assert.equal(reads, 2, "the timer and explicit drain are waiting on fleet snapshots");
	assert.equal(spawn.stopSpawnQueue(), 1);
	assert.match(queued.startError, /shutdown/);
	assert.equal(await spawn.currentStatus(queued, h.deps), "gone");
	list.resolve([]);
	assert.equal(await waiting, 0);
	assert.equal(await starting, 0, "shutdown aborts an in-flight queued start");
	assert.equal(active.starts[0].signal.aborted, true);
	assert.equal(booting.submitted, false);
	assert.match(booting.startError, /boot aborted/);
	await setImmediate();
	spawn.ensureDrainLoop(h.deps);
	t.mock.timers.tick(30_000);
	assert.equal(reads, 2, "shutdown callbacks never rearm the queue timer");
	assert.equal(h.starts.length, 0, "a fleet snapshot resolved after shutdown cannot start a pane");
	assert.equal(spawn.stopSpawnQueue(), 0, "shutdown is idempotent");
	assert.equal(await spawn.drainQueueOnce(h.deps), 0);
});
