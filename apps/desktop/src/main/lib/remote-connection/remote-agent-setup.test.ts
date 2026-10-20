import { describe, expect, it } from "bun:test";
import { toDesktopEventType } from "./agent-event-types";
import {
	buildClaudeInstallCommand,
	buildRemoteAgentFiles,
	mergeRemoteClaudeSettings,
	remoteClaudeFallbackPath,
} from "./remote-agent-setup";

const FOLDER = "/srv/odin";

describe("buildRemoteAgentFiles", () => {
	const files = buildRemoteAgentFiles(FOLDER);
	const byPath = new Map(files.map((file) => [file.path, file]));

	it("puts the hook scripts and the claude wrapper under the odin folder", () => {
		expect([...byPath.keys()].sort()).toEqual([
			"/srv/odin/bin/claude",
			"/srv/odin/hooks/notify.sh",
			"/srv/odin/hooks/shell-rule.sh",
			"/srv/odin/hooks/subagent-cap.sh",
		]);
		for (const file of files) expect(file.mode).toBe(0o755);
	});

	it("wraps claude with the agent identity the server records states under", () => {
		const wrapper = byPath.get("/srv/odin/bin/claude")?.content ?? "";
		expect(wrapper).toContain('export ODIN_AGENT_ID="claude"');
		// It must skip its own directory or it would exec itself forever.
		expect(wrapper).toContain('"/srv/odin/bin"|');
		expect(wrapper).toContain(remoteClaudeFallbackPath(FOLDER));
	});
});

describe("mergeRemoteClaudeSettings", () => {
	it("adds Odin's hooks to a fresh settings file", () => {
		const merged = JSON.parse(mergeRemoteClaudeSettings("", FOLDER) ?? "{}");
		expect(merged.skipDangerousModePermissionPrompt).toBe(true);
		const stopCommands = merged.hooks.Stop.flatMap(
			(definition: { hooks: { command: string }[] }) =>
				definition.hooks.map((hook) => hook.command),
		);
		expect(
			stopCommands.some((c: string) => c.includes("hooks/notify.sh")),
		).toBe(true);
	});

	it("keeps the user's own settings and hooks", () => {
		const existing = JSON.stringify({
			model: "opus",
			hooks: {
				Stop: [{ hooks: [{ type: "command", command: "my-own-hook.sh" }] }],
			},
		});
		const merged = JSON.parse(
			mergeRemoteClaudeSettings(existing, FOLDER) ?? "{}",
		);
		expect(merged.model).toBe("opus");
		const stopCommands = merged.hooks.Stop.flatMap(
			(definition: { hooks: { command: string }[] }) =>
				definition.hooks.map((hook) => hook.command),
		);
		expect(stopCommands).toContain("my-own-hook.sh");
	});

	it("is stable: merging twice changes nothing", () => {
		const once = mergeRemoteClaudeSettings("", FOLDER) ?? "";
		expect(mergeRemoteClaudeSettings(once, FOLDER)).toBe(once);
	});

	it("leaves a file that is not a JSON object alone", () => {
		expect(mergeRemoteClaudeSettings("[1, 2]", FOLDER)).toBeNull();
		expect(mergeRemoteClaudeSettings("{not json", FOLDER)).toBeNull();
	});
});

describe("buildClaudeInstallCommand", () => {
	it("installs only when the server has no claude of its own", () => {
		const command = buildClaudeInstallCommand(FOLDER);
		expect(command.startsWith("if ! bash -lc 'command -v claude'")).toBe(true);
		expect(command).toContain("npm install --prefix '/srv/odin/claude-code'");
		expect(command).toContain("'/srv/odin/node/bin'");
	});
});

describe("toDesktopEventType", () => {
	it("maps host lifecycle names onto the board's", () => {
		expect(toDesktopEventType("Start")).toBe("Start");
		expect(toDesktopEventType("Attached")).toBe("Start");
		expect(toDesktopEventType("Stop")).toBe("Stop");
		expect(toDesktopEventType("Detached")).toBe("Stop");
		expect(toDesktopEventType("PermissionRequest")).toBe("PermissionRequest");
		expect(toDesktopEventType("Failed")).toBe("Failed");
		expect(toDesktopEventType("Something")).toBeNull();
	});
});
