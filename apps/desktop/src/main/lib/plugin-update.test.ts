import { expect, test } from "bun:test";
import { updatePlugins } from "./plugin-update";

test("updatePlugins refreshes marketplaces, updates each user plugin, and reports versions", async () => {
	const calls: string[][] = [];
	let updated = false;
	const result = await updatePlugins(async (args) => {
		calls.push(args);
		if (args[1] === "list") {
			return JSON.stringify([
				{ id: "a@m", version: updated ? "1.1.0" : "1.0.0", scope: "user" },
				{ id: "b@m", version: "2.0.0", scope: "user", enabled: true },
				{ id: "off@m", version: "1.0.0", scope: "user", enabled: false },
				{ id: "repo@m", version: "1.0.0", scope: "project" },
			]);
		}
		if (args[1] === "update" && args[2] === "a@m") updated = true;
		if (args[1] === "update" && args[2] === "b@m") {
			throw Object.assign(new Error("exit 1"), {
				stderr: "Checking...\nPlugin b@m needs its command confirmed\n",
			});
		}
		return "";
	});

	expect(calls[0]).toEqual(["plugin", "marketplace", "update"]);
	expect(calls.filter((args) => args[1] === "update")).toEqual([
		["plugin", "update", "a@m", "--scope", "user"],
		["plugin", "update", "b@m", "--scope", "user"],
	]);
	expect(result).toEqual({
		plugins: [
			{ id: "a@m", from: "1.0.0", to: "1.1.0" },
			{
				id: "b@m",
				from: "2.0.0",
				to: "2.0.0",
				error: "Plugin b@m needs its command confirmed",
			},
		],
	});
});

test("updatePlugins still updates when a marketplace refresh fails, and says so", async () => {
	const result = await updatePlugins(async (args) => {
		if (args[1] === "marketplace")
			throw Object.assign(new Error("exit 1"), {
				stderr: "Marketplace gitkraken failed to load\n",
			});
		if (args[1] === "list")
			return JSON.stringify([{ id: "a@m", version: "1.0.0", scope: "user" }]);
		return "";
	});
	expect(result).toEqual({
		plugins: [{ id: "a@m", from: "1.0.0", to: "1.0.0" }],
		marketplaceError: "Marketplace gitkraken failed to load",
	});
});
