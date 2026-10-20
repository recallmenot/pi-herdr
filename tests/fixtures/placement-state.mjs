export function collectPlacementState(state, records) {
	const remember = (key, id) => { if (id && !state[key].includes(id)) state[key].push(id); };
	for (const rec of records) {
		remember("panes", rec.paneId);
		remember("tabs", rec.allocation?.tabId);
		if (!rec.sessionPath) continue;
		const details = { name: rec.name, path: rec.sessionPath, plan: rec.launchPlan, origin: rec.origin, allocation: rec.allocation };
		const saved = state.sessions.find((s) => s.name === rec.name);
		if (saved) Object.assign(saved, details);
		else state.sessions.push(details);
	}
}
