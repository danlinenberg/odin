/**
 * Puts Anthropic's Claude Code binary at dist/resources/bin/claude (claude.exe
 * on Windows), so a computer with no `claude` of its own can still run sessions. electron-builder ships
 * that folder as Resources/resources/bin. Yours on PATH always wins - see the
 * wrapper's fallback in agent-wrappers-common.ts.
 *
 * Same source and checks as https://claude.ai/install.sh (install.ps1 on
 * Windows): the stable channel,
 * that version's manifest, and the binary's sha256 from it. Cached per version
 * in .cache/claude so a rebuild doesn't download 200 MB again.
 */
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

const BASE = "https://downloads.claude.ai/claude-code-releases";
// The Windows installer is x64; ARM Windows runs it under emulation.
const PLATFORM = { darwin: "darwin-arm64", win32: "win32-x64" }[
	process.platform as string
];
if (!PLATFORM) {
	console.log(`[fetch-claude] no bundled Claude for ${process.platform}`);
	process.exit(0);
}
const BINARY = process.platform === "win32" ? "claude.exe" : "claude";

async function get(url: string): Promise<Response> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`[fetch-claude] ${url}: HTTP ${res.status}`);
	return res;
}

const version = (await (await get(`${BASE}/stable`)).text()).trim();
if (!/^\d+\.\d+\.\d+/.test(version)) {
	throw new Error(`[fetch-claude] unexpected version: ${version.slice(0, 80)}`);
}
const manifest = (await (
	await get(`${BASE}/${version}/manifest.json`)
).json()) as { platforms: Record<string, { checksum: string }> };
const checksum = manifest.platforms[PLATFORM]?.checksum;
if (!checksum) throw new Error(`[fetch-claude] no ${PLATFORM} in manifest`);

const sha256 = (file: string) =>
	createHash("sha256").update(readFileSync(file)).digest("hex");

const cached = join(".cache/claude", version, BINARY);
if (!existsSync(cached) || sha256(cached) !== checksum) {
	mkdirSync(join(".cache/claude", version), { recursive: true });
	const body = Buffer.from(
		await (await get(`${BASE}/${version}/${PLATFORM}/${BINARY}`)).arrayBuffer(),
	);
	const got = createHash("sha256").update(body).digest("hex");
	if (got !== checksum) {
		throw new Error(`[fetch-claude] checksum mismatch for ${version}`);
	}
	writeFileSync(cached, body);
}

const out = join("dist/resources/bin", BINARY);
mkdirSync("dist/resources/bin", { recursive: true });
copyFileSync(cached, out);
chmodSync(out, 0o755);
console.log(`[fetch-claude] Claude Code ${version} -> ${out}`);
