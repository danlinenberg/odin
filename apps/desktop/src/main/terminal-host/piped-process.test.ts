import { describe, expect, test } from "bun:test";
import { spawnPiped } from "./piped-process";

// Echoes its size, then each resize, then what it is sent, whole.
const CHILD = `
console.log("size " + process.env.ODIN_PTY_COLS + "x" + process.env.ODIN_PTY_ROWS);
process.on("message", (m) => console.log("resize " + m.cols + "x" + m.rows));
process.stdin.on("data", (b) => { process.stdout.write(b); process.exit(0); });
`;

describe("spawnPiped", () => {
	test("passes the size, each resize, keys and UTF-8 output through", async () => {
		const child = spawnPiped(process.execPath, ["-e", CHILD], {
			cwd: process.cwd(),
			cols: 100,
			rows: 30,
			env: { PATH: process.env.PATH ?? "" },
		});
		let out = "";
		child.onData((text) => {
			out += text;
		});
		const exited = new Promise<number>((resolve) =>
			child.onExit(({ exitCode }) => resolve(exitCode)),
		);
		const waitFor = async (text: string) => {
			for (let i = 0; i < 100 && !out.includes(text); i++) await Bun.sleep(20);
		};
		await waitFor("size");
		child.resize(120, 40);
		await waitFor("resize");
		child.write("─✓\n");
		expect(await exited).toBe(0);
		expect(out).toContain("size 100x30");
		expect(out).toContain("resize 120x40");
		expect(out).toContain("─✓");
	});
});
