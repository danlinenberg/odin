import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOT_OWNER_EXIT, ownerCheckScript } from "./owner";

const home = mkdtempSync(join(tmpdir(), "odin-owner-"));
const owners = () => readFileSync(join(home, ".odin", "owners"), "utf8");
const check = (ids: string[]) =>
	spawnSync("bash", ["-c", ownerCheckScript(ids)], {
		env: { PATH: process.env.PATH, HOME: home },
		encoding: "utf8",
	});

afterAll(() => rmSync(home, { recursive: true, force: true }));

test("the first Odin claims the user, mode 0600", () => {
	expect(check(["github:dan", "machine:mac-1"]).status).toBe(0);
	expect(owners()).toBe("github:dan\nmachine:mac-1\n");
	expect(statSync(join(home, ".odin", "owners")).mode & 0o777).toBe(0o600);
});

test("the same person on a new Mac, or the same Mac with a GitHub login, is in and adds the new id", () => {
	expect(check(["github:dan", "machine:mac-2"]).status).toBe(0);
	expect(check(["github:dan-l", "machine:mac-1"]).status).toBe(0);
	expect(owners()).toBe(
		"github:dan\nmachine:mac-1\nmachine:mac-2\ngithub:dan-l\n",
	);
});

test("another Odin user is refused and claims nothing", () => {
	const other = check(["github:someone", "machine:mac-9"]);
	expect(other.status).toBe(NOT_OWNER_EXIT);
	expect(other.stderr).toContain("belongs to another Odin user");
	expect(owners()).not.toContain("someone");
	expect(owners()).not.toContain("mac-9");
});

test("an id is matched whole, never as a prefix or a pattern", () => {
	expect(check(["github:da", "machine:mac-"]).status).toBe(NOT_OWNER_EXIT);
	expect(check(["github:.*"]).status).toBe(NOT_OWNER_EXIT);
});

test("no ids is a bug, not an open door", () => {
	expect(() => ownerCheckScript([])).toThrow();
});
