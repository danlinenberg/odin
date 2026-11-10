import { describe, expect, mock, test } from "bun:test";

mock.module("electron", () => ({ shell: {} }));
mock.module("./vscode-bridge", () => ({ vscodeHost: async () => "odin-x" }));

const { viewUrl } = await import("./view-on-mac");

describe("viewUrl", () => {
	test("carries the password, so Screen Sharing asks for nothing", () => {
		expect(viewUrl(51234, "iydAXuDu")).toBe("vnc://:iydAXuDu@localhost:51234");
	});

	test("escapes a password that would break the link", () => {
		expect(viewUrl(1, "a@b:c/d")).toBe("vnc://:a%40b%3Ac%2Fd@localhost:1");
	});
});
