import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReposRouter, scanRepos } from "./repos";

test("scanRepos finds checkouts, skips pruned dirs and nested worktrees", async () => {
	const home = mkdtempSync(join(tmpdir(), "odin-repos-"));
	const make = (path: string) =>
		mkdirSync(join(home, path), { recursive: true });

	make("dev/odin/.git");
	make("dev/work/api/.git");
	// Pruned: a checkout vendored inside node_modules is not a repo you'd pick.
	make("dev/odin/node_modules/some-dep/.git");
	// Not a repo.
	make("Documents/notes");
	// Pruned: TCC-protected folders are never descended into, or macOS prompts.
	make("Desktop/scratch/.git");
	make("Documents/notes/.git");
	make("Downloads/cloned-repo/.git");

	expect(await scanRepos(home)).toEqual([
		join(home, "dev/odin"),
		join(home, "dev/work/api"),
	]);
});

test("the default repo round-trips through the config file, and rejects a non-repo", async () => {
	const home = mkdtempSync(join(tmpdir(), "odin-default-repo-"));
	process.env.ODIN_CONFIG_PATH = join(home, "odin.json");
	delete process.env.DAN_DEFAULT_REPO;
	const repo = join(home, "dev/odin");
	mkdirSync(join(repo, ".git"), { recursive: true });
	mkdirSync(join(home, "Documents"), { recursive: true });

	const caller = createReposRouter().createCaller({});

	expect(await caller.getDefault()).toBeNull();
	await caller.setDefault({ path: repo });
	expect(await caller.getDefault()).toBe(repo);

	expect(caller.setDefault({ path: join(home, "Documents") })).rejects.toThrow(
		/Not a git repo/,
	);
	// Still the one that was set — a rejected pick must not clear it.
	expect(await caller.getDefault()).toBe(repo);

	await caller.setDefault({ path: null });
	expect(await caller.getDefault()).toBeNull();
});
