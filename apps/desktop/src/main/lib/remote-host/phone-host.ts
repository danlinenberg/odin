import type { BoardSnapshot } from "main/lib/phone/host/sessions";
import { sh } from "./session";

/**
 * The phone server on the remote host (main/lib/phone/host), put there and
 * kept running by the user's own Odin, as the host user: no sudo, and nothing
 * for the user to install. It is one JavaScript file Odin builds
 * (dist/main/phone-host.js), run by bun, which Odin downloads into
 * ~/.odin/bin when the host has none, pinned by SHA-256 as the GitHub CLI is
 * (session.ts). Odin sends it at each token push while phone access is on
 * (host-tokens), with the board's remote cards, and asks it for the pairing
 * link Settings shows as a second QR code.
 */

const BUN_VERSION = "1.3.14";
/** bun-linux-<arch>.zip's SHA-256, from that release's SHASUMS256.txt. */
const BUN_SHA256 = {
	"x64-baseline":
		"a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7",
	aarch64: "a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b",
} as const;

export const PHONE_HOST_BUN = '"$HOME/.odin/bin/bun"';
const DIR = '"$HOME/.odin/phone-host"';
const SCRIPT = `${DIR}/phone-host.js`;

/** bun in ~/.odin/bin, unless the one there is this version. Unzipped with python3: no unzip needed. */
export const bunInstallScript = [
	`if [ "$(${PHONE_HOST_BUN} --version 2>/dev/null)" != ${BUN_VERSION} ]; then`,
	`  case "$(uname -m)" in aarch64|arm64) a=aarch64; sum=${BUN_SHA256.aarch64};; *) a=x64-baseline; sum=${BUN_SHA256["x64-baseline"]};; esac`,
	"  t=$(mktemp -d)",
	`  curl -fsSL -o "$t/bun.zip" "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-$a.zip" &&`,
	'  echo "$sum  $t/bun.zip" | sha256sum -c --quiet &&',
	`  python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$t/bun.zip" "$t" &&`,
	`  mkdir -p "$HOME/.odin/bin" && chmod 755 "$t/bun-linux-$a/bun" && mv -f "$t/bun-linux-$a/bun" ${PHONE_HOST_BUN}`,
	'  rm -rf "$t"',
	"fi",
	`[ -x ${PHONE_HOST_BUN} ] || { echo "Odin couldn't download bun for the phone server on this host." >&2; exit 1; }`,
].join("\n");

/** Writes base64 `data` to `path` whole, mode 0600; `$changed` set when it differs. */
const writeIfChanged = (path: string, data: string) =>
	`printf %s ${sh(Buffer.from(data).toString("base64"))} | base64 -d > ${path}.new && if cmp -s ${path}.new ${path}; then rm -f ${path}.new; else mv -f ${path}.new ${path}; changed=1; fi`;

/**
 * Run as the host user, with the server's JavaScript on stdin: installs bun
 * and the script, writes the relay and the laptop's board, and starts the
 * server, or restarts it when the script or the relay changed. The board
 * alone needs no restart: the server reads it at each request.
 */
export function phoneHostScript(config: {
	relay: string;
	name: string;
	board: BoardSnapshot;
}): string {
	return [
		"umask 077",
		`mkdir -p ${DIR} && chmod 700 ${DIR}`,
		bunInstallScript,
		"changed=",
		`cat > ${SCRIPT}.new && if cmp -s ${SCRIPT}.new ${SCRIPT}; then rm -f ${SCRIPT}.new; else mv -f ${SCRIPT}.new ${SCRIPT}; changed=1; fi`,
		writeIfChanged(
			`${DIR}/config.json`,
			JSON.stringify({ relay: config.relay, name: config.name }),
		),
		`printf %s ${sh(Buffer.from(JSON.stringify(config.board)).toString("base64"))} | base64 -d > ${DIR}/board.json.new && mv -f ${DIR}/board.json.new ${DIR}/board.json`,
		`pid=$(cat ${DIR}/server.pid 2>/dev/null)`,
		'if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then [ -z "$changed" ] && exit 0; kill "$pid"; sleep 1; fi',
		`setsid nohup ${PHONE_HOST_BUN} ${SCRIPT} serve > ${DIR}/log 2>&1 < /dev/null &`,
		"true",
	].join("\n");
}

/** The pairing link the server makes: its key, a live one-time code, the relay. */
export const phoneHostLinkScript = `${PHONE_HOST_BUN} ${SCRIPT} link`;

/** Unpairs every phone from the host: a new key there, an empty list. */
export const phoneHostUnpairScript = `[ ! -f ${SCRIPT} ] || ${PHONE_HOST_BUN} ${SCRIPT} unpair`;
