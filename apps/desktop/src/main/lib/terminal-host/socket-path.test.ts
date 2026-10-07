import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { terminalHostSocketPath } from "./socket-path";

describe("terminalHostSocketPath", () => {
	test("is a socket file in the Odin home outside Windows", () => {
		expect(terminalHostSocketPath("/home/me/.odin", "darwin")).toBe(
			join("/home/me/.odin", "terminal-host.sock"),
		);
	});

	test("is a named pipe on Windows, distinct per Odin home", () => {
		const a = terminalHostSocketPath("C:\\Users\\me\\.odin", "win32");
		const b = terminalHostSocketPath("C:\\Users\\me\\.odin-feature", "win32");
		expect(a).toStartWith("\\\\.\\pipe\\odin-terminal-host-");
		expect(a).not.toBe(b);
		expect(terminalHostSocketPath("C:\\Users\\me\\.odin", "win32")).toBe(a);
	});
});
