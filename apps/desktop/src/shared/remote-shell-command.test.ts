import { describe, expect, test } from "bun:test";
import { remoteShellArgv, remoteShellCommand } from "./remote-shell-command";

describe("remoteShellArgv", () => {
	test("reads back the parts of the command it was built from", () => {
		const parts = {
			exe: "C:\\Users\\dan\\AppData\\Local\\Programs\\Odin\\Odin.exe",
			script:
				"C:\\Program Files\\Odin's\\resources\\app.asar\\dist\\main\\remote-shell.js",
			spec: "C:\\Users\\dan\\.odin\\remote-specs\\pane-1.json",
			ticket: "AbC_12-xyz",
		};
		expect(remoteShellArgv(remoteShellCommand(parts))).toEqual({
			exe: parts.exe,
			args: [parts.script, parts.spec, parts.ticket],
		});
	});

	test("any other command is not one", () => {
		expect(remoteShellArgv("cd '/x' && claude 'hi'")).toBeNull();
		expect(
			remoteShellArgv("ELECTRON_RUN_AS_NODE=1 '/a/Odin' '/a/other.js' '/s' t"),
		).toBeNull();
	});
});
