import { expect, test } from "bun:test";
import {
	asLastRun,
	clusterMember,
	hostByName,
	tagCluster,
} from "./host-by-name";

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

test("hosts sharing the main host's cluster tag join it, and leave without it", () => {
	const at = (id: string, cluster: string | null, state = "running") => ({
		id,
		state,
		ssmOnline: true,
		cluster,
	});
	const instances = [
		at("i-main", "prod"),
		at("i-two", "prod"),
		at("i-three", "prod", "stopped"),
		at("i-dev", "dev"),
		at("i-gone", "prod", "terminated"),
	];
	const plan = tagCluster("i-main", instances, [
		{ instanceId: "i-three", byTag: true },
		{ instanceId: "i-gone", byTag: true },
		{ instanceId: "i-old", byTag: true },
		{ instanceId: "i-hand" },
	]);
	expect(plan.join.map((instance) => instance.id)).toEqual(["i-two"]);
	expect(plan.leave).toEqual(["i-gone", "i-old"]);
	// A main host with no tag: every host the tag brought in leaves.
	expect(
		tagCluster(
			"i-main",
			[at("i-main", null)],
			[{ instanceId: "i-two", byTag: true }, { instanceId: "i-hand" }],
		),
	).toEqual({ join: [], leave: ["i-two"] });
});
