import { expect, test } from "bun:test";
import { sessionTitle, untruncatedTitle } from "./OdinPromptDialog";

const line =
	"In claude code, I want to text under the cursor to be better contrasted";

test("the title is the prompt's whole first line", () => {
	expect(sessionTitle(`${line}\nmore`, "x")).toBe(line);
});

test("an old 60-char title gets the rest back from its brief", () => {
	expect(untruncatedTitle(`${line.slice(0, 59)}…`, line)).toBe(line);
	expect(untruncatedTitle("Wait…", "something else")).toBe("Wait…");
	expect(untruncatedTitle("Plain", line)).toBe("Plain");
});
