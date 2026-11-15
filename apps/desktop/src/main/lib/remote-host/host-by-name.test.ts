import { expect, test } from "bun:test";
import { asLastRun, clusterMember, hostByName } from "./host-by-name";

const prod = { name: "odin-prod", instanceId: "i-prod" };
const dev = { name: "odin-remote", instanceId: "i-dev" };

test("a session finds the host it started on after another is picked", () => {
	expect(hostByName(prod, [dev], "odin-remote")).toBe(dev);
	expect(hostByName(prod, [dev], "odin-prod")).toBe(prod);
	expect(hostByName(prod, [dev], undefined)).toBe(prod);
	expect(hostByName(prod, [dev], "gone")).toBe(prod);
});

test("a session reconnects as the host user it started as", () => {
	const work = { ...prod, user: "odin-dan-linenberg" };
	expect(asLastRun(work, { instanceId: "i-prod", user: "odin-dan" }).user).toBe(
		"odin-dan",
	);
	expect(asLastRun(work, { instanceId: "i-dev", user: "odin-dan" })).toBe(work);
	expect(asLastRun(work, null)).toBe(work);
	expect(asLastRun(work, { instanceId: "i-prod" })).toBe(work);
});

test("a cluster host takes the main host's settings, not its own sign-ins", () => {
	const main = {
		...prod,
		user: "odin-me",
		profile: "work",
		connectors: ["slack"],
		jiraHostSignIn: true,
		githubHostSignIns: ["me"],
		awayTasks: true,
	};
	const member = clusterMember(main, {
		instanceId: "i-two",
		name: "odin-two",
		region: undefined,
	});
	expect(member as unknown).toEqual({
		name: "odin-two",
		instanceId: "i-two",
		user: "odin-me",
		profile: "work",
		connectors: ["slack"],
	});
});
