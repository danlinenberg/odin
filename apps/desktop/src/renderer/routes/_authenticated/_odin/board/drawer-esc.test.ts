import { describe, expect, test } from "bun:test";
import {
	drawerEscAction,
	escStaysWithTarget,
	replyBoxOwnsEsc,
	targetOwnsEsc,
} from "./drawer-esc";

// A stand-in for a DOM element: `closest` walks up through the parents and
// matches on the attributes the selector names.
type Fake = { attrs: Record<string, string>; parent?: Fake };
const el = (attrs: Record<string, string>, parent?: Fake) => {
	const node: Fake & { closest: (selector: string) => unknown } = {
		attrs,
		parent,
		closest(selector: string) {
			for (let at: Fake | undefined = node; at; at = at.parent) {
				for (const one of selector.split(",")) {
					const m = one.trim().match(/^\[([\w-]+)(?:=([\w-]+))?\]$/);
					if (!m) continue;
					const [, name, value] = m;
					if (
						name in at.attrs &&
						(value === undefined || at.attrs[name] === value)
					)
						return at;
				}
			}
			return null;
		},
	};
	return node as unknown as EventTarget & Fake;
};

describe("escStaysWithTarget", () => {
	test("the reply box with its @ or / list open keeps the Esc", () => {
		const box = el({ "data-owns-esc": "" }, el({ "data-chat": "" }));
		expect(escStaysWithTarget(box)).toBe(true);
	});
	test("a box opened over the pane keeps the Esc", () => {
		expect(escStaysWithTarget(el({}, el({ role: "dialog" })))).toBe(true);
	});
	test("an open menu or list keeps the Esc", () => {
		expect(escStaysWithTarget(el({}, el({ role: "menu" })))).toBe(true);
		expect(escStaysWithTarget(el({ role: "listbox" }))).toBe(true);
	});
	test("the reply box with nothing open hands the Esc to the drawer", () => {
		expect(escStaysWithTarget(el({}, el({ "data-chat": "" })))).toBe(false);
	});
	test("no target, or a target that is not an element, goes to the drawer", () => {
		expect(escStaysWithTarget(null)).toBe(false);
		expect(escStaysWithTarget({} as EventTarget)).toBe(false);
	});
});

describe("targetOwnsEsc", () => {
	test("only an element marked as owning Esc, not any dialog", () => {
		expect(targetOwnsEsc(el({ "data-owns-esc": "" }))).toBe(true);
		expect(targetOwnsEsc(el({}, el({ role: "dialog" })))).toBe(false);
		expect(targetOwnsEsc(null)).toBe(false);
	});
});

describe("replyBoxOwnsEsc", () => {
	test("an open @ or / list owns Esc", () => {
		expect(
			replyBoxOwnsEsc({ menuOpen: true, bash: false, draft: "check @cha" }),
		).toBe(true);
		expect(replyBoxOwnsEsc({ menuOpen: true, bash: false, draft: "/" })).toBe(
			true,
		);
	});
	test("an empty ! line owns Esc: it leaves bash mode", () => {
		expect(replyBoxOwnsEsc({ menuOpen: false, bash: true, draft: "" })).toBe(
			true,
		);
	});
	test("a plain draft does not: Esc closes the drawer as before", () => {
		expect(replyBoxOwnsEsc({ menuOpen: false, bash: false, draft: "hi" })).toBe(
			false,
		);
		expect(replyBoxOwnsEsc({ menuOpen: false, bash: true, draft: "ls" })).toBe(
			false,
		);
	});
});

describe("drawerEscAction", () => {
	const idle = {
		selecting: false,
		renaming: false,
		working: false,
		interrupting: false,
	};
	test("mid-turn, Esc stops the turn and the screen stays open", () => {
		expect(drawerEscAction({ ...idle, working: true })).toBe("interrupt");
	});
	test("with nothing running, Esc goes back to the board", () => {
		expect(drawerEscAction(idle)).toBe("close");
	});
	test("a second Esc while the stop is on its way does nothing", () => {
		expect(
			drawerEscAction({ ...idle, working: true, interrupting: true }),
		).toBe("wait");
		expect(drawerEscAction({ ...idle, interrupting: true })).toBe("wait");
	});
	test("select mode and a rename still take Esc first, even mid-turn", () => {
		expect(drawerEscAction({ ...idle, working: true, selecting: true })).toBe(
			"leave-select",
		);
		expect(drawerEscAction({ ...idle, working: true, renaming: true })).toBe(
			"cancel-rename",
		);
	});
});
