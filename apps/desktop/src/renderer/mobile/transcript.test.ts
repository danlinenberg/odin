import { expect, test } from "bun:test";
import { ago } from "./cards";
import { leadingTldr, segments } from "./transcript";

const user = (text: string) => ({ role: "user" as const, text });
const odin = (text: string) => ({ role: "assistant" as const, text });

test("a TL;DR leads only a reply too long to read whole", () => {
	const short = { last: "Fixed the sort.", urgency: null, long: false };
	expect(leadingTldr(short)).toBeNull();
	expect(leadingTldr({ ...short, long: true })).toEqual({
		...short,
		long: true,
	});
	expect(leadingTldr(null)).toBeNull();
});

test("a turn's in-between messages fold; its last answer stays open", () => {
	const shape = segments([
		user("q1"),
		odin("step a"),
		odin("step b"),
		odin("answer 1"),
		user("q2"),
		odin("answer 2"),
	]).map((s) =>
		s.kind === "fold"
			? `fold(${s.messages.map((m) => m.message.text).join(",")})`
			: s.message.text,
	);
	expect(shape).toEqual([
		"q1",
		"fold(step a,step b)",
		"answer 1",
		"q2",
		"answer 2",
	]);
});

test("a turn still running folds what came before its latest message", () => {
	const shape = segments([user("q"), odin("a"), odin("b")]).map((s) => s.kind);
	expect(shape).toEqual(["message", "fold", "message"]);
});

test("ago reads minutes, hours, days", () => {
	const now = 1_000_000_000;
	expect(ago(now - 20_000, now)).toBe("now");
	expect(ago(now - 5 * 60_000, now)).toBe("5m");
	expect(ago(now - 3 * 3_600_000, now)).toBe("3h");
	expect(ago(now - 2 * 86_400_000, now)).toBe("2d");
});
