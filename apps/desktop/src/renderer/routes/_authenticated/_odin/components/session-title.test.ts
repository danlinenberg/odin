import { expect, test } from "bun:test";
import {
	cardBody,
	restartPrompt,
	sessionTitle,
	untruncatedTitle,
} from "./OdinPromptDialog";

const line =
	"In claude code, I want to text under the cursor to be better contrasted";

test("the title is the prompt's whole first line", () => {
	expect(sessionTitle(`${line}\nmore`, "x")).toBe(line);
});

test("an attachment on a line of its own is not the title - the words after it are", () => {
	const img = "/Users/dan/.odin/attachments/1792565097715-nty207.png";
	expect(sessionTitle(`${img}\n\nbeautify`, "x")).toBe("beautify");
	expect(sessionTitle(`${img}\nbeautify the login page\nmore`, "x")).toBe(
		"beautify the login page",
	);
	expect(sessionTitle("![](odin-attachment://file/a.png)\n\nfix it", "x")).toBe(
		"fix it",
	);
	// Nothing but the file: the path still names the session.
	expect(sessionTitle(img, "x")).toBe(img);
	expect(sessionTitle("", "x")).toBe("x");
	// A line that starts with a path but says more is the ask.
	expect(sessionTitle("/Users/dan/dev is slow", "x")).toBe(
		"/Users/dan/dev is slow",
	);
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

test("a restart prompt carries the title once, however often it restarted", () => {
	const img = "/Users/dan/.odin/attachments/x.png";
	expect(restartPrompt(line, `${line}\n\n${line}\n\n${img}`)).toBe(
		`${line}\n\n${img}`,
	);
	expect(restartPrompt(line, `${line}\nmore`)).toBe(`${line}\n\nmore`);
	expect(restartPrompt(line, "other ask")).toBe(`${line}\n\nother ask`);
	expect(restartPrompt(line, line)).toBe(line);
	expect(restartPrompt(line, null)).toBe(line);
	// The attachment that came before the words goes under the title.
	expect(restartPrompt("beautify", `${img}\n\nbeautify`)).toBe(
		`beautify\n\n${img}`,
	);
});
