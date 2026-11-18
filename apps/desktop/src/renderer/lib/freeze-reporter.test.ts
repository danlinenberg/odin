import { expect, test } from "bun:test";
import { describeFrame } from "./freeze-reporter";

test("names the slowest scripts first", () => {
	const line = describeFrame(
		2400.4,
		[
			{
				duration: 100,
				invoker: "a",
				sourceURL: "x/a.js",
				sourceFunctionName: "small",
			},
			{
				duration: 2000,
				invoker: "click",
				sourceURL: "x/index-abc.js",
				sourceFunctionName: "onClick",
				sourceCharPosition: 42,
			},
		],
		"#/board",
	);
	expect(line).toBe(
		"[freeze] frame 2400ms on #/board | 2000ms click onClick index-abc.js:42 | 100ms a small a.js:0",
	);
});
