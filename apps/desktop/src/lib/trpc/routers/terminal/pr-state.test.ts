import { describe, expect, test } from "bun:test";
import { type GhExec, pullRequestState } from "./pr-state";

const URL = "https://github.com/imagenai/app-web-server/pull/6409";

const STATUS = `github.com
  ✓ Logged in to github.com account danlinenberg (keyring)
  - Active account: true
  ✓ Logged in to github.com account dan-linenberg-imagenai (keyring)
  - Active account: false
`;

describe("pullRequestState", () => {
	test("reads the state the active account can see", async () => {
		const exec: GhExec = async () => ({ stdout: '{"state":"MERGED"}' });
		expect(await pullRequestState(URL, exec)).toBe("MERGED");
	});

	test("falls through the logged-in accounts until one can see the repo", async () => {
		const calls: Array<{ args: string[]; env?: Record<string, string> }> = [];
		const exec: GhExec = async (args, env) => {
			calls.push({ args, env });
			if (args[1] === "status") return { stdout: STATUS };
			if (args[1] === "token") return { stdout: `tok-${args[3]}\n` };
			// Only the work account can resolve this org's repo.
			if (env?.GH_TOKEN !== "tok-dan-linenberg-imagenai") {
				throw new Error("Could not resolve to a Repository");
			}
			return { stdout: '{"state":"CLOSED"}' };
		};
		expect(await pullRequestState(URL, exec)).toBe("CLOSED");
		expect(calls.map((call) => call.args.slice(0, 4).join(" "))).toEqual([
			`pr view ${URL} --json`,
			"auth status",
			"auth token --user danlinenberg",
			`pr view ${URL} --json`,
			"auth token --user dan-linenberg-imagenai",
			`pr view ${URL} --json`,
		]);
	});

	test("no state rather than a throw when gh can't answer", async () => {
		const exec: GhExec = async () => {
			throw new Error("gh: command not found");
		};
		expect(await pullRequestState(URL, exec)).toBeNull();
	});
});
