import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyShellEnvToProcess,
	getProcessEnvWithShellEnv,
	getProcessEnvWithShellPath,
} from "./shell-env";

describe("shell env merging", () => {
	test("getProcessEnvWithShellEnv fills in missing shell variables", async () => {
		const env = await getProcessEnvWithShellEnv(
			{
				PATH: "/usr/bin:/bin",
				NODE_ENV: "development",
			},
			{
				PATH: "/opt/homebrew/bin:/usr/bin:/bin",
				GITHUB_TOKEN: "ghp_test",
				GH_TOKEN: "ghp_alt",
			},
		);

		expect(env.PATH).toBe("/usr/bin:/bin");
		expect(env.NODE_ENV).toBe("development");
		expect(env.GITHUB_TOKEN).toBe("ghp_test");
		expect(env.GH_TOKEN).toBe("ghp_alt");
	});

	test("applyShellEnvToProcess preserves existing values", async () => {
		const targetEnv: NodeJS.ProcessEnv = {
			NODE_ENV: "production",
			GITHUB_TOKEN: "existing-token",
		};

		await applyShellEnvToProcess(targetEnv, {
			NODE_ENV: "development",
			GITHUB_TOKEN: "shell-token",
			GH_TOKEN: "shell-gh-token",
		});

		expect(targetEnv.NODE_ENV).toBe("production");
		expect(targetEnv.GITHUB_TOKEN).toBe("existing-token");
		expect(targetEnv.GH_TOKEN).toBe("shell-gh-token");
	});

	test("applyShellEnvToProcess ignores empty shell env input", async () => {
		const targetEnv: NodeJS.ProcessEnv = {};

		await applyShellEnvToProcess(targetEnv, {});

		expect(targetEnv).toEqual({});
	});
});

describe("getProcessEnvWithShellPath preserves user git env vars", () => {
	test("keeps pager and editor variables in the returned env", async () => {
		const env = await getProcessEnvWithShellPath({
			PATH: "/usr/bin:/bin",
			EDITOR: "vim",
			GIT_EDITOR: "vim",
			PAGER: "less",
			GIT_PAGER: "less",
		});

		expect(env.EDITOR).toBe("vim");
		expect(env.GIT_EDITOR).toBe("vim");
		expect(env.PAGER).toBe("less");
		expect(env.GIT_PAGER).toBe("less");
	});
});

describe("shell env cache", () => {
	test("getShellEnvironment forceRefresh bypasses cached values", async () => {
		const { clearShellEnvCache, getShellEnvironment } = await import(
			"./shell-env"
		);
		const zshPath = ["/bin/zsh", "/usr/bin/zsh"].find((candidate) =>
			existsSync(candidate),
		);
		if (!zshPath) {
			return;
		}

		const tmpDir = mkdtempSync(
			join(realpathSync(tmpdir()), "shell-env-refresh-test-"),
		);
		const zshrcPath = join(tmpDir, ".zshrc");
		writeFileSync(
			zshrcPath,
			'export __ODIN_SHELL_ENV_REFRESH_TEST__="first"\n',
		);

		const origZDOTDIR = process.env.ZDOTDIR;
		const origShell = process.env.SHELL;
		process.env.SHELL = zshPath;
		process.env.ZDOTDIR = tmpDir;
		clearShellEnvCache();

		try {
			const cachedEnv = await getShellEnvironment();
			expect(cachedEnv.__ODIN_SHELL_ENV_REFRESH_TEST__).toBe("first");

			writeFileSync(
				zshrcPath,
				'export __ODIN_SHELL_ENV_REFRESH_TEST__="second"\n',
			);

			const stillCachedEnv = await getShellEnvironment();
			expect(stillCachedEnv.__ODIN_SHELL_ENV_REFRESH_TEST__).toBe("first");

			const refreshedEnv = await getShellEnvironment({ forceRefresh: true });
			expect(refreshedEnv.__ODIN_SHELL_ENV_REFRESH_TEST__).toBe("second");
		} finally {
			if (origZDOTDIR !== undefined) process.env.ZDOTDIR = origZDOTDIR;
			else delete process.env.ZDOTDIR;
			if (origShell !== undefined) process.env.SHELL = origShell;
			else delete process.env.SHELL;
			clearShellEnvCache();
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("an expired cache is served stale, then refreshed in the background", async () => {
		const { clearShellEnvCache, expireShellEnvCache, getShellEnvironment } =
			await import("./shell-env");
		const zshPath = ["/bin/zsh", "/usr/bin/zsh"].find((candidate) =>
			existsSync(candidate),
		);
		if (!zshPath) {
			return;
		}

		const tmpDir = mkdtempSync(
			join(realpathSync(tmpdir()), "shell-env-stale-test-"),
		);
		const zshrcPath = join(tmpDir, ".zshrc");
		const write = (value: string) =>
			writeFileSync(
				zshrcPath,
				`export __ODIN_SHELL_ENV_STALE_TEST__="${value}"\n`,
			);
		write("first");

		const origZDOTDIR = process.env.ZDOTDIR;
		const origShell = process.env.SHELL;
		process.env.SHELL = zshPath;
		process.env.ZDOTDIR = tmpDir;
		clearShellEnvCache();

		try {
			// Cold read pays for the shell spawn — that one is allowed to block.
			const cold = await getShellEnvironment();
			expect(cold.__ODIN_SHELL_ENV_STALE_TEST__).toBe("first");

			write("second");
			expireShellEnvCache();

			// The point of the change: an expired cache answers immediately with
			// the old value instead of waiting on another `zsh -ilc`.
			const startedAt = Date.now();
			const stale = await getShellEnvironment();
			expect(stale.__ODIN_SHELL_ENV_STALE_TEST__).toBe("first");
			expect(Date.now() - startedAt).toBeLessThan(50);

			// ...and the refresh it kicked off lands on its own.
			let refreshed = "";
			for (let attempt = 0; attempt < 100; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 50));
				refreshed =
					(await getShellEnvironment()).__ODIN_SHELL_ENV_STALE_TEST__ ?? "";
				if (refreshed === "second") break;
			}
			expect(refreshed).toBe("second");
		} finally {
			if (origZDOTDIR !== undefined) process.env.ZDOTDIR = origZDOTDIR;
			else delete process.env.ZDOTDIR;
			if (origShell !== undefined) process.env.SHELL = origShell;
			else delete process.env.SHELL;
			clearShellEnvCache();
			rmSync(tmpDir, { recursive: true, force: true });
		}
	}, 30_000);
});
