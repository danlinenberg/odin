import { expect, it } from "bun:test";
import { parseCommand } from "./telegram";

it("reads a message as a command, with or without the slash, anything else as a task", () => {
	expect(parseCommand("Tasks")).toEqual({ kind: "tasks" });
	expect(parseCommand("/tasks@OdinBot")).toEqual({ kind: "tasks" });
	expect(parseCommand("/status")).toEqual({ kind: "status" });
	expect(parseCommand("/start")).toEqual({ kind: "help" });
	expect(parseCommand("start 1, 3")).toEqual({ kind: "start", rows: [1, 3] });
	expect(parseCommand("start the build")).toEqual({
		kind: "add",
		text: "start the build",
	});
	expect(parseCommand("!!! fix login\nit 500s")).toEqual({
		kind: "add",
		text: "!!! fix login\nit 500s",
	});
});
