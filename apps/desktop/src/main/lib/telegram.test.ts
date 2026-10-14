import { expect, it } from "bun:test";
import { answerWrites, parseCommand, screenTail } from "./telegram";

it("reads a message as a command, with or without the slash, anything else as a task", () => {
	expect(parseCommand("Tasks")).toEqual({ kind: "tasks" });
	expect(parseCommand("/tasks@OdinBot")).toEqual({ kind: "tasks" });
	expect(parseCommand("/status")).toEqual({ kind: "status" });
	expect(parseCommand("/start")).toEqual({ kind: "help" });
	expect(parseCommand("start 1, 3")).toEqual({ kind: "start", rows: [1, 3] });
	expect(parseCommand("screen 2")).toEqual({ kind: "screen", row: 2 });
	expect(parseCommand("/done 1")).toEqual({ kind: "done", row: 1 });
	expect(parseCommand("/screen")).toEqual({ kind: "status" });
	expect(parseCommand("start the build")).toEqual({
		kind: "add",
		text: "start the build",
	});
	expect(parseCommand("!!! fix login\nit 500s")).toEqual({
		kind: "add",
		text: "!!! fix login\nit 500s",
	});
});

it("keeps the end of the screen, without blank lines", () => {
	const text = Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join("");
	const tail = screenTail(JSON.stringify({ text }));
	expect(tail.split("\n")).toHaveLength(20);
	expect(tail.endsWith("line 29")).toBe(true);
	expect(screenTail("Failed: no pane")).toBe("Failed: no pane");
});

it("types a multi-line reply as one paste, then Enter", () => {
	expect(answerWrites("yes")).toEqual(["yes", "\r"]);
	expect(answerWrites("use plan B\nand skip the tests")).toEqual([
		"\x1b[200~use plan B\nand skip the tests\x1b[201~",
		"\r",
	]);
});
