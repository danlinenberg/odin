import { expect, test } from "bun:test";
import {
	asLastRun,
	autoCluster,
	clusterMember,
	hostByName,
	pickedHost,
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

test("every listed host joins the cluster, and one that is gone leaves", () => {
	const at = (id: string, state = "running", ssmOnline = true) => ({
		id,
		state,
		ssmOnline,
	});
	const plan = autoCluster(
		"i-main",
		[
			at("i-main"),
			at("i-two"),
			at("i-three", "stopped"),
			at("i-four", "running", false),
			at("i-gone", "terminated"),
		],
		[
			{ instanceId: "i-three" },
			{ instanceId: "i-gone" },
			{ instanceId: "i-old" },
		],
	);
	// A stopped member stays; one SSM can't reach joins once it can.
	expect(plan.join.map((instance) => instance.id)).toEqual(["i-two"]);
	// Gone or no longer listed leaves.
	expect(plan.leave).toEqual(["i-gone", "i-old"]);
});

test("a host picked again comes back with its settings", () => {
	const past = {
		instanceId: "i-prod",
		name: "odin-prod",
		awayTasks: true,
		awsProfiles: ["dev"],
	};
	const picked = { instanceId: "i-prod", name: "odin-prod", on: true };
	expect(pickedHost(picked, [undefined, past])).toEqual({
		host: {
			instanceId: "i-prod",
			name: "odin-prod",
			on: true,
			awayTasks: true,
			awsProfiles: ["dev"],
		},
		restored: true,
	});
	expect(pickedHost({ instanceId: "i-new", name: "new" }, [past])).toEqual({
		host: { instanceId: "i-new", name: "new" },
		restored: false,
	});
});
