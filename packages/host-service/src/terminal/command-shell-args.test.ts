import { describe, expect, it } from "bun:test";
import { buildCommandShellArgs } from "./terminal";

describe("buildCommandShellArgs", () => {
	it("runs the command in a login shell, so the PTY ends with it", () => {
		const [flag, script] = buildCommandShellArgs("claude --resume x", "");
		expect(flag).toBe("-lc");
		expect(script).toBe("claude --resume x");
	});

	it("puts Odin's bin dir first so its claude wrapper wins", () => {
		const [, script] = buildCommandShellArgs("claude", "/srv/odin");
		expect(script).toBe(`export PATH='/srv/odin/bin':"$PATH"\nclaude`);
	});

	it("quotes a bin dir with a single quote in it", () => {
		const [, script] = buildCommandShellArgs("true", "/srv/o'din");
		expect(script).toStartWith(`export PATH='/srv/o'\\''din/bin':`);
	});
});
