import { beforeEach, expect, test } from "bun:test";
import { useNextInLinePrompt } from "renderer/stores/next-in-line-prompt";
import { runAction, writeState } from "./crow-state";

const enabled = () => useNextInLinePrompt.getState().offHours.enabled;

beforeEach(() =>
	useNextInLinePrompt.getState().setOffHours({ enabled: false }),
);

test("action=set can't turn the Night Agent on, only off", () => {
	expect(
		writeState({ store: "nightAgent", patch: '{"offHours":{"enabled":true}}' }),
	).toContain("action=setting");
	expect(enabled()).toBe(false);
	useNextInLinePrompt.getState().setOffHours({ enabled: true });
	expect(
		writeState({
			store: "nightAgent",
			patch: '{"offHours":{"enabled":false}}',
		}),
	).toStartWith("Updated");
	expect(enabled()).toBe(false);
});

test("action=run turning the Night Agent on is undone and refused", async () => {
	expect(
		await runAction({
			store: "nightAgent",
			fn: "setOffHours",
			args: '[{"enabled":true}]',
		}),
	).toContain("action=setting");
	expect(enabled()).toBe(false);
	expect(
		await runAction({
			store: "nightAgent",
			fn: "setOffHours",
			args: '[{"maxSessions":3}]',
		}),
	).toStartWith("Ran");
	expect(useNextInLinePrompt.getState().offHours.maxSessions).toBe(3);
});
