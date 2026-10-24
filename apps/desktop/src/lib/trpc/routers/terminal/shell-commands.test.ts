import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { parseShellCommands, shellCommands } from "./shell-commands";

describe("shellCommands", () => {
	test("names each shell's first child, null at the prompt, skips the gone", () => {
		const ps = [
			"  10     1 -zsh",
			"  11    10 /usr/local/bin/ngrok",
			"  12    11 /usr/bin/helper",
			"  20     1 /bin/zsh",
		].join("\n");
		expect(parseShellCommands(ps, [10, 20, 30])).toEqual({
			10: "ngrok",
			20: null,
		});
	});

	// The `; :` keeps sh from exec-ing sleep in its own place, so sleep stays
	// its child - a shell running a command.
	const running = spawn("sh", ["-c", "sleep 30; :"]);
	const idle = spawn("sleep", ["30"]);
	afterAll(() => {
		running.kill("SIGKILL");
		idle.kill("SIGKILL");
	});

	test("reads running, idle and disconnected from the live process table", async () => {
		const runningPid = running.pid as number;
		const idlePid = idle.pid as number;
		// Give sh a moment to fork sleep.
		await new Promise((resolve) => setTimeout(resolve, 200));
		const commands = await shellCommands([runningPid, idlePid, 999_999]);
		expect(commands[runningPid]).toBe("sleep");
		expect(commands[idlePid]).toBeNull();
		expect(999_999 in commands).toBe(false);
	});
});
