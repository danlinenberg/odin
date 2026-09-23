import { expect, test } from "bun:test";
import { cardBody, sessionTitle, untruncatedTitle } from "./OdinPromptDialog";

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

test("a Slack title that skipped the greeting line still finds its line", () => {
	const text = `Hey Dan,\n${line} please\nthanks`;
	expect(untruncatedTitle(`${line.slice(0, 40)}…`, text)).toBe(
		`${line} please`,
	);
});

test("the card body is the brief minus the title and bare links", () => {
	expect(cardBody("Iris scope", `Hey Dan,\n${line}`)).toBe(`Hey Dan,\n${line}`);
	expect(cardBody(line, `${line}\nmore detail`)).toBe("more detail");
	expect(cardBody("CRR-1: x", "CRR-1: x\nhttps://jira/CRR-1")).toBeNull();
	expect(cardBody("x", null)).toBeNull();
});
