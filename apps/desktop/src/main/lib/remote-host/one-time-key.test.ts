import { expect, test } from "bun:test";
import { oneTimeKeyScript } from "./ssm";

test("the SSM login key lasts until its expiry and refuses odd input", () => {
	const script = oneTimeKeyScript(
		"odin-meirav",
		"ssh-ed25519 AAAAC3Nza+/= odin@laptop",
		new Date("2026-10-22T14:03:00Z"),
	);
	expect(script).toContain(
		`echo 'expiry-time="202610221403Z" ssh-ed25519 AAAAC3Nza+/= odin-once'`,
	);
	expect(() =>
		oneTimeKeyScript("x; rm -rf /", "ssh-ed25519 AAAA", new Date()),
	).toThrow();
	expect(() =>
		oneTimeKeyScript("ubuntu", "ssh-ed25519 AA'AA", new Date()),
	).toThrow();
});
