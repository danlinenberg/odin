import { describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeSetupPart } from "./claude-sync";
import { makeAutoSync, setupFingerprint, waitAtMost } from "./setup-autosync";

/** A ~/.claude with one skill and a settings file. */
function claudeHome() {
	const root = mkdtempSync(join(tmpdir(), "odin-autosync-"));
	mkdirSync(join(root, "skills", "deploy"), { recursive: true });
	writeFileSync(join(root, "skills", "deploy", "SKILL.md"), "# Deploy\n");
	writeFileSync(join(root, "settings.json"), "{}");
	return root;
}

describe("setupFingerprint", () => {
	test("stays the same while nothing changes", async () => {
		const root = claudeHome();
		expect(await setupFingerprint(["skills"], root)).toBe(
			await setupFingerprint(["skills"], root),
		);
	});

	test("changes when a skill is added", async () => {
		const root = claudeHome();
		const before = await setupFingerprint(["skills"], root);
		mkdirSync(join(root, "skills", "release-notes"));
		writeFileSync(join(root, "skills", "release-notes", "SKILL.md"), "# R\n");
		expect(await setupFingerprint(["skills"], root)).not.toBe(before);
	});

	test("changes when a skill is edited", async () => {
		const root = claudeHome();
		const file = join(root, "skills", "deploy", "SKILL.md");
		utimesSync(file, 1_000, 1_000);
		const before = await setupFingerprint(["skills"], root);
		utimesSync(file, 2_000, 2_000);
		expect(await setupFingerprint(["skills"], root)).not.toBe(before);
	});

	test("follows a linked skill to its files, as the copy does", async () => {
		const root = claudeHome();
		const elsewhere = mkdtempSync(join(tmpdir(), "odin-autosync-repo-"));
		writeFileSync(join(elsewhere, "SKILL.md"), "# Linked\n");
		symlinkSync(elsewhere, join(root, "skills", "linked"));
		const before = await setupFingerprint(["skills"], root);
		writeFileSync(join(elsewhere, "extra.md"), "more");
		expect(await setupFingerprint(["skills"], root)).not.toBe(before);
	});

	test("a part not chosen doesn't count", async () => {
		const root = claudeHome();
		const before = await setupFingerprint(["skills"], root);
		writeFileSync(join(root, "settings.json"), '{"model":"x"}');
		expect(await setupFingerprint(["skills"], root)).toBe(before);
	});

	test("node_modules is left out", async () => {
		const root = claudeHome();
		const before = await setupFingerprint(["skills"], root);
		mkdirSync(join(root, "skills", "deploy", "node_modules"));
		writeFileSync(join(root, "skills", "deploy", "node_modules", "x.js"), "");
		expect(await setupFingerprint(["skills"], root)).toBe(before);
	});
});

type Host = { id: string };

function fakeSync(print: () => string) {
	const sent = new Map<string, string>();
	const copies: string[] = [];
	const logged: unknown[] = [];
	let parts: ClaudeSetupPart[] = ["skills"];
	let fail = false;
	let gate: Promise<void> = Promise.resolve();
	const sync = makeAutoSync<Host>({
		parts: () => parts,
		fingerprint: async () => print(),
		keyOf: (host) => host.id,
		sent: (key) => sent.get(key),
		record: (key, value) => sent.set(key, value),
		copy: async (host) => {
			await gate;
			if (fail) throw new Error("host unreachable");
			copies.push(host.id);
		},
		log: (_message, error) => logged.push(error),
	});
	return {
		sync,
		sent,
		copies,
		logged,
		setParts: (next: ClaudeSetupPart[]) => {
			parts = next;
		},
		setFail: (next: boolean) => {
			fail = next;
		},
		hold: () => {
			let open = () => {};
			gate = new Promise((resolve) => {
				open = resolve;
			});
			return open;
		},
	};
}

describe("makeAutoSync", () => {
	test("copies to a host that never got this setup, then not again", async () => {
		const fake = fakeSync(() => "v1");
		expect(await fake.sync({ id: "a" })).toBe(true);
		expect(await fake.sync({ id: "a" })).toBe(false);
		expect(fake.copies).toEqual(["a"]);
	});

	test("copies again once the setup changed", async () => {
		let version = "v1";
		const fake = fakeSync(() => version);
		await fake.sync({ id: "a" });
		version = "v2";
		expect(await fake.sync({ id: "a" })).toBe(true);
		expect(fake.copies).toEqual(["a", "a"]);
	});

	test("each cluster host keeps its own record", async () => {
		const fake = fakeSync(() => "v1");
		await fake.sync({ id: "a" });
		expect(await fake.sync({ id: "b" })).toBe(true);
		expect(fake.copies).toEqual(["a", "b"]);
	});

	test("nothing chosen in Settings: nothing copied", async () => {
		const fake = fakeSync(() => "v1");
		fake.setParts([]);
		expect(await fake.sync({ id: "a" })).toBe(false);
		expect(fake.copies).toEqual([]);
	});

	test("a failed copy is logged, never thrown, and tried again next time", async () => {
		const fake = fakeSync(() => "v1");
		fake.setFail(true);
		expect(await fake.sync({ id: "a" })).toBe(false);
		expect(fake.logged).toHaveLength(1);
		expect(fake.sent.has("a")).toBe(false);
		fake.setFail(false);
		expect(await fake.sync({ id: "a" })).toBe(true);
	});

	test("two sessions starting at once share one copy", async () => {
		const fake = fakeSync(() => "v1");
		const open = fake.hold();
		const first = fake.sync({ id: "a" });
		const second = fake.sync({ id: "a" });
		expect(second).toBe(first);
		open();
		await first;
		expect(fake.copies).toEqual(["a"]);
	});
});

describe("waitAtMost", () => {
	test("returns the result when it comes in time", async () => {
		expect(await waitAtMost(Promise.resolve(7), 1_000)).toBe(7);
	});

	test("gives up after the wait, so a session start isn't held", async () => {
		const never = new Promise<number>(() => {});
		const started = Date.now();
		expect(await waitAtMost(never, 20)).toBeNull();
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	test("a rejected job counts as no result", async () => {
		expect(await waitAtMost(Promise.reject(new Error("x")), 1_000)).toBeNull();
	});
});
