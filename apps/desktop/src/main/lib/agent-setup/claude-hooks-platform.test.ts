import { describe, expect, it } from "bun:test";
import {
	type ClaudeSettingsJson,
	mergeClaudeManagedSettings,
	windowsHookCommand,
} from "./agent-wrappers-claude-codex-opencode";

const NOTIFY = "/home/me/.odin/hooks/notify.sh";

function managedHooks(settings: ClaudeSettingsJson) {
	return Object.values(settings.hooks ?? {})
		.flat()
		.flatMap((definition) => definition.hooks ?? [])
		.filter((hook) => hook.command.includes("ODIN_HOME_DIR"));
}

describe("Claude hooks per platform", () => {
	it("on Windows, runs every hook through PowerShell and never fails", () => {
		const hooks = managedHooks(mergeClaudeManagedSettings({}, NOTIFY, "win32"));
		expect(hooks.length).toBeGreaterThan(5);
		for (const hook of hooks) {
			expect(hook.shell).toBe("powershell");
			expect(hook.command).toContain("$env:ODIN_HOME_DIR + '/hooks/");
			expect(hook.command).toContain("bin\\bash.exe");
			expect(hook.command.endsWith("exit 0")).toBe(true);
			expect(hook.command).not.toContain("[ -n");
			// A caller quoting it for powershell.exe may strip double quotes.
			expect(hook.command).not.toContain('"');
		}
	});

	it("on Linux and macOS, keeps the bash hooks", () => {
		for (const platform of ["linux", "darwin"] as const) {
			const hooks = managedHooks(
				mergeClaudeManagedSettings({}, NOTIFY, platform),
			);
			for (const hook of hooks) {
				expect(hook.shell).toBeUndefined();
				expect(hook.command.startsWith('[ -n "$ODIN_HOME_DIR" ]')).toBe(true);
			}
		}
	});

	it("replaces the other platform's hooks instead of adding to them", () => {
		const linux = mergeClaudeManagedSettings({}, NOTIFY, "linux");
		const count = managedHooks(linux).length;
		const windows = mergeClaudeManagedSettings(
			structuredClone(linux),
			NOTIFY,
			"win32",
		);
		expect(managedHooks(windows).length).toBe(count);
		const back = mergeClaudeManagedSettings(
			structuredClone(windows),
			NOTIFY,
			"linux",
		);
		expect(managedHooks(back)).toEqual(managedHooks(linux));
	});

	it("leaves the user's own hooks alone", () => {
		const mine = { type: "command" as const, command: "echo mine" };
		const merged = mergeClaudeManagedSettings(
			{ hooks: { Stop: [{ hooks: [mine] }] } },
			NOTIFY,
			"win32",
		);
		expect(merged.hooks?.Stop?.[0]?.hooks).toEqual([mine]);
	});

	it("tags notify with the agent, and names the script", () => {
		expect(windowsHookCommand("notify.sh", "claude")).toContain(
			"$env:ODIN_AGENT_ID = 'claude';",
		);
		expect(windowsHookCommand("shell-rule.sh")).not.toContain("ODIN_AGENT_ID");
	});
});
