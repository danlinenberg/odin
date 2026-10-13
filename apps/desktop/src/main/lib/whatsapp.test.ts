import { expect, it } from "bun:test";
import { parseCommand } from "./whatsapp";

it("reads a self-chat message as a command, anything else as a task", () => {
	expect(parseCommand("Tasks")).toEqual({ kind: "tasks" });
	expect(parseCommand("status")).toEqual({ kind: "status" });
	expect(parseCommand("?")).toEqual({ kind: "help" });
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
