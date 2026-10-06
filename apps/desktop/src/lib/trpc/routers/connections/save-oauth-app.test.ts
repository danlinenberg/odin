import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNotionOAuthApp } from "../odin-config";
import { createConnectionsRouter } from ".";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "odin-oauth-app-"));
	process.env.ODIN_CONFIG_PATH = join(dir, "odin.json");
});
afterEach(() => {
	delete process.env.ODIN_CONFIG_PATH;
	rmSync(dir, { recursive: true, force: true });
});

test("a pasted app makes an unbaked build offer sign-in", async () => {
	const caller = createConnectionsRouter().createCaller({} as never);
	expect(
		(await caller.oauthConfigured({ provider: "notion" })).configured,
	).toBe(false);
	const saved = await caller.saveOAuthApp({
		provider: "notion",
		clientId: " id ",
		clientSecret: "secret",
		redirectUrl: "https://odin.example/notion.html",
	});
	expect(saved.configured).toBe(true);
	expect(resolveNotionOAuthApp()).toEqual({
		clientId: "id",
		clientSecret: "secret",
		redirectUrl: "https://odin.example/notion.html",
	});
});
