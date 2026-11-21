import { describe, expect, it } from "bun:test";
import type { AllItem } from "../all/all-items";
import {
	guardDone,
	guardTasksDone,
	useDoneGuard,
	withOpenTodos,
} from "./done-guard";
import { usePaneMeta } from "./usePaneMeta";

const a = { paneId: "pa", title: "Fix login" };
const b = { paneId: "pb", title: "Write docs" };
const c = { paneId: "pc", title: "No notes" };

describe("withOpenTodos", () => {
	it("keeps only sessions with an unticked to-do, in order", () => {
		const todos = {
			pa: [{ text: "ask about tests", done: true }, { text: "check CI" }],
			pb: [{ text: "all ticked", done: true }],
		};
		expect(withOpenTodos([a, b, c], todos)).toEqual([a]);
	});
});

describe("guardDone", () => {
	it("goes straight on when nothing is open", () => {
		let ran = 0;
		guardDone([c], () => ran++);
		expect(ran).toBe(1);
		expect(useDoneGuard.getState().pending).toBeNull();
	});

	it("holds Done for the warning while a to-do is unticked", () => {
		usePaneMeta.getState().addTodo("pa", "check CI");
		let ran = 0;
		guardDone([a, c], () => ran++);
		expect(ran).toBe(0);
		const pending = useDoneGuard.getState().pending;
		expect(pending?.sessions).toEqual([a]);
		expect(pending?.what).toBe("these sessions");
		pending?.proceed();
		expect(ran).toBe(1);
		useDoneGuard.getState().close();
		expect(useDoneGuard.getState().pending).toBeNull();
	});
});

describe("guardTasksDone (bulk Done on ticked rows)", () => {
	const rowA = { key: "task:a" } as AllItem;
	const rowB = { key: "task:b" } as AllItem;
	const sessionsOf = (item: AllItem) => (item.key === "task:a" ? [a] : [b, c]);

	it("asks once for the lot, listing every session with an open to-do", () => {
		usePaneMeta.getState().addTodo("pa", "check CI");
		usePaneMeta.getState().addTodo("pb", "update the changelog");
		let ran = 0;
		guardTasksDone([rowA, rowB], () => ran++, sessionsOf);
		expect(ran).toBe(0);
		const pending = useDoneGuard.getState().pending;
		expect(pending?.sessions.map((s) => s.paneId)).toEqual(["pa", "pb"]);
		expect(pending?.what).toBe("these tasks");
		pending?.proceed();
		expect(ran).toBe(1);
		useDoneGuard.getState().close();
	});

	it("goes straight on when no ticked row has an open to-do", () => {
		let ran = 0;
		guardTasksDone(
			[{ key: "task:z" } as AllItem],
			() => ran++,
			() => [c],
		);
		expect(ran).toBe(1);
		expect(useDoneGuard.getState().pending).toBeNull();
	});
});
