/**
 * The remote host's real phone server, for the phone screens to talk to end
 * to end without a phone or a Mac: `bun scripts/e2e-host.ts` on a remote host.
 *
 * It starts a relay on localhost and the phone server (main/lib/phone/host)
 * against a copy of this user's Odin files in a temp home, so nothing the
 * screens do lands in the real ones: its own key, its own pairing, a copy of
 * the board the Mac last sent and of the night folder. Claude's folder and
 * the pane files are linked, not copied, and tmux is this user's, so the
 * board lists the sessions really running here, and a reply typed in the
 * screens reaches that real session. The walk only acts on the practice
 * session it adds (below).
 *
 * Serves a new pair link at each GET of http://localhost:4802, which e2e.ts
 * takes in place of a link.
 */
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { relayId } from "@odin/channel";
import { startRelay } from "../../../packages/odin-relay/src/relay";
import {
	hostFiles,
	hostTrust,
	pairingLink,
	startHostServer,
} from "../../desktop/src/main/lib/phone/host/server";
import { hostPaths } from "../../desktop/src/main/lib/phone/host/sessions";

const PORT = Number(Bun.env.E2E_RELAY_PORT ?? 4801);
const real = homedir();
const home = mkdtempSync(join(tmpdir(), "odin-e2e-"));
mkdirSync(join(home, ".odin", "phone-host"), { recursive: true });
const link = (path: string) => {
	if (existsSync(join(real, path)))
		symlinkSync(join(real, path), join(home, path));
};
const copy = (path: string) => {
	if (existsSync(join(real, path)))
		// The board's age decides which sessions it lists: keep it.
		cpSync(join(real, path), join(home, path), {
			recursive: true,
			preserveTimestamps: true,
		});
};
link(".claude");
link(".odin/panes");
copy(".odin/night");
copy(".odin/phone-host/board.json");
hostPaths.home = home;

/**
 * A practice session, "E2E practice session", for the walk to reply to, stop
 * and mark Done: a tmux session named as Odin names them, a script called
 * `claude` in it that keeps what is typed (typed.log in the temp home), and a
 * short conversation. Gone when this stops.
 */
const practice = crypto.randomUUID();
const fake = join(home, "claude");
writeFileSync(
	fake,
	`#!/bin/bash\necho "E2E practice session"\nwhile IFS= read -r line; do echo "$line" >> ${home}/typed.log; echo "> $line"; done\n`,
	{ mode: 0o755 },
);
// Its conversation sits with Claude's real ones (the server reads only real
// folders there), in a folder of its own that goes when this stops.
const talk = join(real, ".claude", "projects", "-odin-e2e-practice");
mkdirSync(talk, { recursive: true });
const row = (role: "user" | "assistant", text: string, at: number) =>
	JSON.stringify({
		type: role,
		uuid: crypto.randomUUID(),
		sessionId: practice,
		timestamp: new Date(at).toISOString(),
		message: {
			role,
			content: role === "user" ? text : [{ type: "text", text }],
		},
	});
writeFileSync(
	join(talk, `${practice}.jsonl`),
	`${row("user", "E2E practice session", Date.now() - 60_000)}\n${row("assistant", "Ready. Reply to me, stop me, or mark me Done: nothing real is behind this session.", Date.now() - 30_000)}\n`,
);
const tmuxDo = (...args: string[]) => Bun.spawnSync(["tmux", ...args]);
tmuxDo("new-session", "-d", "-s", `odin-${practice}`, `${fake}; true`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.on(signal, () => {
		tmuxDo("kill-session", "-t", `odin-${practice}`);
		rmSync(talk, { recursive: true, force: true });
		process.exit(0);
	});

const relay = `ws://localhost:${PORT}`;
startRelay({ port: PORT, hostname: "127.0.0.1" });
writeFileSync(hostFiles().config, JSON.stringify({ relay, name: "e2e host" }));
if (!startHostServer()) throw new Error("The phone server didn't start");

// The screens take ws:// only as the Wi-Fi address, so the relay goes there.
// A pairing code works once, and each walk is a new phone: a new link each time.
const trust = hostTrust();
function pairLink(): string {
	const params = new URLSearchParams(new URL(pairingLink(trust)).search);
	params.delete("r");
	params.set("l", `${relay}/connect/${relayId(trust.identity().publicKey)}`);
	return `odin://pair?${params}`;
}
Bun.serve({
	port: PORT + 1,
	hostname: "127.0.0.1",
	fetch: () => new Response(pairLink()),
});
console.log(`home: ${home}`);
console.log(`pair link, a new one each time: http://localhost:${PORT + 1}`);
