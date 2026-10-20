import { describe, expect, test } from "bun:test";
import {
	hostGithubAccounts,
	hostGithubLogin,
	repoStaysLocal,
} from "./github-on-host";

const host = {
	on: true,
	instanceId: "i-1",
	name: "work",
	user: "ubuntu",
	reposRoot: "~/repos",
};
const work = { login: "dan-work", token: "w" };
const personal = { login: "danlinenberg", token: "p" };

describe("hostGithubAccounts", () => {
	test("no choice made yet: the main connection alone goes, as before", () => {
		expect(
			hostGithubAccounts({
				githubLogin: "dan-work",
				githubAccounts: [personal],
				remoteHost: host,
			}),
		).toEqual([
			{ login: "dan-work", onHost: true, main: true },
			{ login: "danlinenberg", onHost: false, main: false },
		]);
	});

	test("the list, once written, is the whole truth", () => {
		expect(
			hostGithubAccounts({
				githubLogin: "dan-work",
				githubAccounts: [personal],
				remoteHost: { ...host, githubOnHost: ["danlinenberg"] },
			}),
		).toEqual([
			{ login: "dan-work", onHost: false, main: true },
			{ login: "danlinenberg", onHost: true, main: false },
		]);
		expect(
			hostGithubAccounts({
				githubLogin: "dan-work",
				remoteHost: { ...host, githubOnHost: [] },
			}),
		).toEqual([{ login: "dan-work", onHost: false, main: true }]);
	});

	test("logins compare without case, and a main connection without a login is not listed", () => {
		expect(
			hostGithubAccounts({
				githubLogin: "Dan-Work",
				githubAccounts: [work],
				remoteHost: { ...host, githubOnHost: ["dan-work"] },
			}),
		).toEqual([{ login: "Dan-Work", onHost: true, main: true }]);
		expect(
			hostGithubAccounts({ githubAccounts: [personal], remoteHost: host }),
		).toEqual([{ login: "danlinenberg", onHost: false, main: false }]);
	});
});

describe("hostGithubLogin", () => {
	const config = {
		githubLogin: "dan-work",
		githubAccounts: [personal, { login: "other", token: "o" }],
		remoteHost: { ...host, githubOnHost: ["dan-work", "other"] },
	};

	test("the account that owns the repo, when it may go", () => {
		expect(hostGithubLogin(config, "Other")).toBe("other");
	});

	test("else the main connection, else the first allowed", () => {
		expect(hostGithubLogin(config, "imagenai")).toBe("dan-work");
		expect(hostGithubLogin(config)).toBe("dan-work");
		expect(
			hostGithubLogin({
				...config,
				remoteHost: { ...host, githubOnHost: ["other"] },
			}),
		).toBe("other");
	});

	test("an owner kept off the host never gets its own token there", () => {
		expect(hostGithubLogin(config, "danlinenberg")).toBe("dan-work");
	});

	test("none allowed: nothing goes", () => {
		expect(
			hostGithubLogin({ ...config, remoteHost: { ...host, githubOnHost: [] } }),
		).toBe(null);
	});
});

describe("repoStaysLocal", () => {
	const config = {
		githubLogin: "dan-work",
		githubAccounts: [personal],
		remoteHost: host,
	};

	test("a repo owned by an account kept off the host", () => {
		expect(repoStaysLocal(config, "danlinenberg")).toBe(true);
		expect(repoStaysLocal(config, "DanLinenberg")).toBe(true);
	});

	test("anything else goes to the host", () => {
		expect(repoStaysLocal(config, "imagenai")).toBe(false);
		expect(repoStaysLocal(config, "dan-work")).toBe(false);
		expect(repoStaysLocal(config, null)).toBe(false);
	});

	test("letting the account go lets its repos go", () => {
		expect(
			repoStaysLocal(
				{
					...config,
					remoteHost: { ...host, githubOnHost: ["dan-work", "danlinenberg"] },
				},
				"danlinenberg",
			),
		).toBe(false);
	});
});
