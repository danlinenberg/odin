import { describe, expect, test } from "bun:test";
import { applyLines } from "./ChatView";
import { parseShell } from "./shell-output";

const user = (uuid: string, content: string) => ({
	type: "user",
	uuid,
	message: { content },
});

describe("parseShell", () => {
	test("reads a ! command, its output, and a built-in command's output", () => {
		expect(parseShell("<bash-input>df -h</bash-input>")).toEqual({
			command: "df -h",
			stdout: "",
			stderr: "",
		});
		expect(
			parseShell(
				"<bash-stdout>running\timpaired\n</bash-stdout><bash-stderr>warn</bash-stderr>",
			),
		).toEqual({ stdout: "running\timpaired", stderr: "warn" });
		expect(
			parseShell(
				"<local-command-stdout>\x1b[1mTotal cost:\x1b[22m $0.12</local-command-stdout>",
			),
		).toEqual({ stdout: "Total cost: $0.12", stderr: "" });
		expect(parseShell("hi <bash-input>x</bash-input>")?.command).toBe("x");
		expect(parseShell("just text")).toBeNull();
	});

	test("output folds into its command; empty output alone shows nothing", () => {
		const items = applyLines(
			[],
			[
				user("a", "<bash-input>ls</bash-input>"),
				user("b", "<bash-stdout>x</bash-stdout><bash-stderr></bash-stderr>"),
				user("c", "<local-command-stdout></local-command-stdout>"),
			],
		);
		expect(items).toEqual([
			{
				kind: "user",
				id: "a",
				text: "!ls",
				at: undefined,
				shell: { command: "ls", stdout: "x", stderr: "" },
			},
		]);
	});
});
