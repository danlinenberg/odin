import { describe, expect, test } from "bun:test";
import { initTRPC } from "@trpc/server";
import { z } from "zod";
import {
	callProcedure,
	GUARDED_REPLY,
	isGuardedMutation,
	listProcedures,
	setOdinApiRouter,
} from "./odin-api";

const t = initTRPC.create();
let saved = "";
setOdinApiRouter(
	t.router({
		settings: t.router({
			get: t.procedure.query(() => ({ theme: "dark" })),
			set: t.procedure
				.input(z.object({ theme: z.string() }))
				.mutation(({ input }) => {
					saved = input.theme;
				}),
			watch: t.procedure.subscription(() => undefined as never),
		}),
	}),
);

describe("odin-api", () => {
	test("lists queries and mutations with their input, not subscriptions", () => {
		const list = listProcedures();
		expect(list).toContain("query settings.get - no input");
		expect(list).toContain('mutation settings.set - {"type":"object"');
		expect(list).not.toContain("settings.watch");
		expect(listProcedures("nothing")).toBe('No procedure matches "nothing".');
	});

	test("calls a procedure by path with JSON input", async () => {
		expect(await callProcedure("settings.get")).toContain('"theme": "dark"');
		expect(await callProcedure("settings.set", '{"theme":"light"}')).toBe(
			"Done.",
		);
		expect(saved).toBe("light");
	});

	test("explains a bad call instead of throwing", async () => {
		expect(await callProcedure("settings.nope")).toContain("No procedure");
		expect(await callProcedure("settings.set", "{")).toBe(
			"input must be JSON.",
		);
		expect(await callProcedure("settings.set", "{}")).toStartWith("Failed:");
		expect(await callProcedure("settings.watch")).toBe(
			"Subscriptions can't be called.",
		);
	});
});

describe("guarded settings", () => {
	test("sign-ins, the remote host, auto-start and Slack sending are refused", () => {
		for (const path of [
			"slack.setSendAllowed",
			"remoteHost.setAutoStart",
			"remoteHost.setCustomApiKey",
			"remoteHost.set",
			"connections.disconnect",
			"connections.saveOAuthApp",
			"phone.setEnabled",
			"terminal.renewClaudeToken",
			"config.claudeLogin",
		])
			expect(isGuardedMutation(path)).toBe(true);
	});

	test("everyday operations and profile switching still go through", () => {
		for (const path of [
			"settings.setOpenLinksInApp",
			"terminal.createOrAttach",
			"connections.setActiveProfile",
			"insights.attend",
		])
			expect(isGuardedMutation(path)).toBe(false);
	});

	test("action=call answers a guarded mutation without running it", async () => {
		const g = initTRPC.create();
		let ran = false;
		setOdinApiRouter(
			g.router({
				slack: g.router({
					sendAllowed: g.procedure.query(() => ran),
					setSendAllowed: g.procedure
						.input(z.object({ allowed: z.boolean() }))
						.mutation(() => {
							ran = true;
						}),
				}),
			}),
		);
		expect(
			await callProcedure("slack.setSendAllowed", '{"allowed":true}'),
		).toBe(GUARDED_REPLY);
		expect(ran).toBe(false);
		expect(await callProcedure("slack.sendAllowed")).toBe("false");
	});
});
