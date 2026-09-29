import fs from "node:fs";
import path from "node:path";
import { env } from "shared/env.shared";
import { HOOKS_DIR } from "./paths";

export const NOTIFY_SCRIPT_NAME = "notify.sh";
export const NOTIFY_SCRIPT_MARKER = "# Odin agent notification hook v9";

const NOTIFY_SCRIPT_TEMPLATE_PATH = path.join(
	__dirname,
	"templates",
	"notify-hook.template.sh",
);

export const SUBAGENT_CAP_SCRIPT_NAME = "subagent-cap.sh";
const SUBAGENT_CAP_SCRIPT_MARKER = "# Odin subagent cap hook v1";
// ponytail: 4 subagents machine-wide, not per session. Raise it with
// ODIN_MAX_SUBAGENTS if the machine can take more.
const DEFAULT_SUBAGENT_CAP = 4;

function writeFileIfChanged(
	filePath: string,
	content: string,
	mode: number,
): boolean {
	const existing = fs.existsSync(filePath)
		? fs.readFileSync(filePath, "utf-8")
		: null;
	if (existing === content) {
		try {
			fs.chmodSync(filePath, mode);
		} catch {
			// Best effort.
		}
		return false;
	}

	fs.writeFileSync(filePath, content, { mode });
	return true;
}

export function getNotifyScriptPath(): string {
	return path.join(HOOKS_DIR, NOTIFY_SCRIPT_NAME);
}

export function getNotifyScriptContent(): string {
	const template = fs.readFileSync(NOTIFY_SCRIPT_TEMPLATE_PATH, "utf-8");
	return template
		.replaceAll("{{MARKER}}", NOTIFY_SCRIPT_MARKER)
		.replaceAll("{{DEFAULT_PORT}}", String(env.DESKTOP_NOTIFICATIONS_PORT));
}

export function createNotifyScript(): void {
	const notifyPath = getNotifyScriptPath();
	const script = getNotifyScriptContent();
	const changed = writeFileIfChanged(notifyPath, script, 0o755);
	console.log(`[agent-setup] ${changed ? "Updated" : "Verified"} notify hook`);

	const capScript = fs
		.readFileSync(
			path.join(__dirname, "templates", "subagent-cap.template.sh"),
			"utf-8",
		)
		.replaceAll("{{MARKER}}", SUBAGENT_CAP_SCRIPT_MARKER)
		.replaceAll("{{DEFAULT_CAP}}", String(DEFAULT_SUBAGENT_CAP));
	writeFileIfChanged(
		path.join(HOOKS_DIR, SUBAGENT_CAP_SCRIPT_NAME),
		capScript,
		0o755,
	);
}
