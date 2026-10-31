import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunInstallScript, phoneHostScript } from "./phone-host";

const home = mkdtempSync(join(tmpdir(), "odin-phone-host-mac-"));
const dir = join(home, ".odin", "phone-host");
// A stand-in bun of the pinned version: `serve` records its start and stays up.
mkdirSync(join(home, ".odin", "bin"), { recursive: true });
writeFileSync(
	join(home, ".odin", "bin", "bun"),
	`#!/bin/sh
[ "$1" = --version ] && { echo 1.3.14; exit 0; }
[ "$2" = serve ] && { echo $$ > "$HOME/.odin/phone-host/server.pid"; echo start >> "$HOME/starts"; exec sleep 30; }
`,
);
chmodSync(join(home, ".odin", "bin", "bun"), 0o755);

const run = (script: string, input: string) =>
	spawnSync("bash", ["-c", script], {
		input,
		env: { PATH: process.env.PATH, HOME: home },
		encoding: "utf8",
	});
const starts = () => {
	try {
		return readFileSync(join(home, "starts"), "utf8").split("\n").length - 1;
	} catch {
		return 0;
	}
};
const config = {
	relay: "wss://relay.example",
	name: "dev-box",
	board: { host: "dev-box", sessions: [] },
};
const hasSetsid = spawnSync("sh", ["-c", "command -v setsid"]).status === 0;

afterAll(() => {
	spawnSync("sh", ["-c", `kill $(cat ${dir}/server.pid) 2>/dev/null`]);
});

test("bun is pinned by version and SHA-256, for both architectures", () => {
	expect(bunInstallScript).toContain("bun-v1.3.14/bun-linux-$a.zip");
	expect(bunInstallScript).toContain("sha256sum -c");
	expect(bunInstallScript).toContain("x64-baseline");
	expect(bunInstallScript).toContain("aarch64");
});

test.skipIf(!hasSetsid)(
	"installs the server, writes its relay and board, starts it once, and restarts it on a new build",
	async () => {
		expect(run(phoneHostScript(config), "// v1").status).toBe(0);
		await Bun.sleep(300);
		expect(readFileSync(join(dir, "phone-host.js"), "utf8")).toBe("// v1");
		expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8"))).toEqual({
			relay: "wss://relay.example",
			name: "dev-box",
		});
		expect(JSON.parse(readFileSync(join(dir, "board.json"), "utf8")).host).toBe(
			"dev-box",
		);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		expect(statSync(join(dir, "config.json")).mode & 0o777).toBe(0o600);
		expect(starts()).toBe(1);

		// Same build, new board: the running server reads it, no restart.
		const board = { host: "dev-box", sessions: [{ sessionId: "s" }] };
		expect(
			run(
				phoneHostScript({ ...config, board: board as typeof config.board }),
				"// v1",
			).status,
		).toBe(0);
		await Bun.sleep(300);
		expect(starts()).toBe(1);
		expect(readFileSync(join(dir, "board.json"), "utf8")).toContain('"s"');

		// A new build restarts it.
		const before = readFileSync(join(dir, "server.pid"), "utf8").trim();
		expect(run(phoneHostScript(config), "// v2").status).toBe(0);
		await Bun.sleep(1_500);
		expect(starts()).toBe(2);
		expect(readFileSync(join(dir, "server.pid"), "utf8").trim()).not.toBe(
			before,
		);
	},
);
