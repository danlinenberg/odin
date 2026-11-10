import { expect, test } from "bun:test";
import { downloadTarget, hostPath } from "./download";

test("hostPath keeps absolute paths and makes ~ relative to the login's home", () => {
	expect(hostPath("/tmp/x.csv")).toBe("/tmp/x.csv");
	expect(hostPath("~/out/x.csv")).toBe("out/x.csv");
	expect(hostPath("  out/x.csv ")).toBe("out/x.csv");
	expect(hostPath("~")).toBe(".");
});

test("downloadTarget never overwrites a file already in Downloads", () => {
	const taken = new Set(["/dl/users.csv", "/dl/users (2).csv"]);
	const exists = (path: string) => taken.has(path);
	expect(downloadTarget("/dl", "/tmp/users.csv", exists)).toBe(
		"/dl/users (3).csv",
	);
	expect(downloadTarget("/dl", "/tmp/notes", exists)).toBe("/dl/notes");
	expect(downloadTarget("/dl", "/tmp/out/", exists)).toBe("/dl/out");
});
