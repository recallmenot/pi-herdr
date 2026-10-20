import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

export function runtimeDetails(pi) {
	return {
		pi: execFileSync(process.execPath, [process.argv[1], "--version"], { encoding: "utf8" }).trim(),
		cliPath: process.argv[1],
		paneId: process.env.HERDR_PANE_ID,
		tools: pi.getAllTools().filter((t) => t.name.startsWith("herdr_")).map((t) => t.name).sort(),
	};
}

export default function placementRuntime(pi) {
	pi.on("session_start", () => {
		const session = process.env.PI_HERDR_SESSION;
		if (session) writeFileSync(`${session}.placement-runtime.json`, JSON.stringify(runtimeDetails(pi)));
	});
}
