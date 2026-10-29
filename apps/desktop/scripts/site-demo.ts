/**
 * The trailer on the website (site/demo.mp4, demo.webm and the demo.jpg
 * poster), rendered from site/trailer.html.
 *
 *   bun run site-demo        # from apps/desktop
 *
 * The trailer is one HTML page whose every frame is render(t). This opens it
 * in Electron, steps t at 30 fps and screenshots each frame over CDP, so the
 * video never drops or doubles a frame however slow the machine is. Frames go
 * to ffmpeg twice: FFMPEG (or Playwright's build, which has the VP9 encoder)
 * for the webm, and an ffmpeg with libx264 (FFMPEG_MP4, or `ffmpeg` on PATH)
 * for the H.264 mp4 Safari and QuickTime play. 1920x1200, scored by
 * site-demo-music.ts from the trailer's own moments.
 *
 *   STILLS=1.5,8.4 bun run site-demo     # just those moments, as PNGs in a temp folder
 *   RESCORE=1 bun run site-demo          # just the score, into the videos already there
 */
import { spawn } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import electronBinary from "electron";
import { type Moments, musicWav } from "./site-demo-music";

const SITE = join(import.meta.dir, "..", "..", "..", "site");
const WIDTH = 1600;
const HEIGHT = 1000;
// 1600x1000 CSS pixels, drawn at 1.2x: a 1920x1200 video.
const SCALE = 1.2;
const FPS = 30;
// The poster: the board, a dozen agents sorted.
const POSTER_AT = 10.6;

function findFfmpeg(): string {
	if (process.env.FFMPEG) return process.env.FFMPEG;
	const cache = join(homedir(), ".cache", "ms-playwright");
	const dir =
		existsSync(cache) &&
		readdirSync(cache)
			.filter((d) => d.startsWith("ffmpeg-"))
			.sort()
			.pop();
	if (dir)
		for (const bin of ["ffmpeg-linux", "ffmpeg-mac", "ffmpeg-win64.exe"])
			if (existsSync(join(cache, dir, bin))) return join(cache, dir, bin);
	return "ffmpeg";
}

// A Linux box with no display: Chromium draws offscreen.
const HEADLESS = process.platform === "linux" && !process.env.DISPLAY;

const work = mkdtempSync(join(tmpdir(), "odin-trailer-"));
// A window that only loads the trailer, waiting for its frames to be asked for.
writeFileSync(
	join(work, "package.json"),
	JSON.stringify({ name: "odin-trailer", main: "main.js" }),
);
writeFileSync(
	join(work, "main.js"),
	`const { app, BrowserWindow } = require("electron");
// Frames come from CDP screenshots; no GPU needed, and a box with no display has none.
app.disableHardwareAcceleration();
app.whenReady().then(() => {
	// Frameless: a framed window wants GTK decorations, which a headless Linux box
	// can't draw. There it's also shown: hidden, it never paints. Elsewhere it stays hidden.
	const win = new BrowserWindow({ width: ${WIDTH}, height: ${HEIGHT}, show: ${HEADLESS}, frame: false, paintWhenInitiallyHidden: true, webPreferences: { backgroundThrottling: false } });
	win.loadURL(${JSON.stringify(`${pathToFileURL(join(SITE, "trailer.html")).href}?record`)});
});
`,
);
const env: Record<string, string | undefined> = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const electron = spawn(
	electronBinary as unknown as string,
	[
		work,
		"--remote-debugging-port=0",
		`--user-data-dir=${join(work, "chromium")}`,
		...(HEADLESS ? ["--ozone-platform=headless", "--no-sandbox"] : []),
	],
	{ env, stdio: ["ignore", "pipe", "pipe"] },
);
let log = "";
for (const stream of [electron.stdout, electron.stderr])
	stream?.on("data", (c) => {
		log += c;
	});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function quit(code: number): Promise<never> {
	electron.kill("SIGKILL");
	rmSync(work, { recursive: true, force: true });
	process.exit(code);
}

// --- CDP ---------------------------------------------------------------------
type Target = { type: string; url: string; webSocketDebuggerUrl?: string };
let target: Target | undefined;
const portFile = join(work, "chromium", "DevToolsActivePort");
for (let i = 0; i < 60 && !target; i++) {
	await sleep(500);
	const port =
		existsSync(portFile) && readFileSync(portFile, "utf8").split("\n")[0];
	if (!port) continue;
	const targets = (await fetch(`http://127.0.0.1:${port}/json/list`)
		.then((r) => r.json())
		.catch(() => [])) as Target[];
	target = targets.find(
		(t) => t.type === "page" && t.url.includes("trailer.html"),
	);
}
if (!target?.webSocketDebuggerUrl) {
	console.error("FAIL the trailer never loaded\n", log.slice(-3000));
	await quit(1);
}
const ws = new WebSocket(target?.webSocketDebuggerUrl as string);
let nextId = 1;
type CdpResult = {
	result?: { value?: unknown };
	exceptionDetails?: { text: string };
	data?: string;
};
const pending = new Map<
	number,
	(m: { error?: { message: string }; result?: CdpResult }) => void
>();
ws.onmessage = (e) => {
	const m = JSON.parse(String(e.data));
	pending.get(m.id)?.(m);
	pending.delete(m.id);
};
await new Promise((r) => {
	ws.onopen = r;
});
function send(method: string, params: object = {}): Promise<CdpResult> {
	const id = nextId++;
	ws.send(JSON.stringify({ id, method, params }));
	return new Promise((resolve, reject) =>
		pending.set(id, (m) =>
			m.error ? reject(new Error(m.error.message)) : resolve(m.result ?? {}),
		),
	);
}
async function page<T>(expression: string): Promise<T> {
	const { result, exceptionDetails } = await send("Runtime.evaluate", {
		expression,
		returnByValue: true,
		awaitPromise: true,
	});
	if (exceptionDetails) throw new Error(exceptionDetails.text);
	return result?.value as T;
}

// --- the frames ----------------------------------------------------------------
/** An ffmpeg reading JPEG frames on stdin, and its exit code once it closes. */
function encoder(bin: string, args: string[], out: string, audio?: string) {
	const proc = spawn(
		bin,
		[
			"-loglevel",
			"error",
			"-y",
			"-f",
			"image2pipe",
			"-c:v",
			"mjpeg",
			"-framerate",
			String(FPS),
			"-i",
			"pipe:0",
			...(audio
				? [
						"-i",
						audio,
						"-map",
						"0:v",
						"-map",
						"1:a",
						"-c:a",
						"aac",
						"-b:a",
						"160k",
						"-shortest",
					]
				: ["-an"]),
			...args,
			join(SITE, out),
		],
		{ stdio: ["pipe", "ignore", "inherit"] },
	);
	const closed = new Promise<number>((r) => {
		proc.on("close", (code) => r(code ?? 1));
		proc.on("error", () => r(1));
	});
	return Object.assign(proc, { closed });
}

/** Puts `music` in site/`file` as its sound, keeping its video as is. */
function score(file: string, music: string): boolean {
	const out = join(work, file);
	const ok =
		Bun.spawnSync(
			[
				process.env.FFMPEG_MP4 ?? "ffmpeg",
				"-loglevel",
				"error",
				"-y",
				"-i",
				join(SITE, file),
				"-i",
				music,
				"-map",
				"0:v",
				"-map",
				"1:a",
				"-c:v",
				"copy",
				...(file.endsWith(".webm")
					? ["-c:a", "libopus", "-b:a", "128k"]
					: ["-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart"]),
				"-shortest",
				out,
			],
			{ stderr: "inherit" },
		).exitCode === 0;
	if (ok) writeFileSync(join(SITE, file), readFileSync(out));
	return ok;
}

try {
	await send("Runtime.enable");
	await send("Emulation.setDeviceMetricsOverride", {
		width: WIDTH,
		height: HEIGHT,
		deviceScaleFactor: SCALE,
		mobile: false,
	});
	// Its fonts and images, before the first frame.
	await page(
		`document.fonts.ready.then(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))))`,
	);
	const duration = await page<number>("window.DURATION");
	const music = join(work, "music.wav");
	writeFileSync(music, musicWav(await page<Moments>("window.MOMENTS")));

	// Just the sound: the score swapped into the videos already there, no frames rendered.
	if (process.env.RESCORE) {
		for (const file of ["demo.mp4", "demo.webm"])
			if (!score(file, music)) throw new Error(`couldn't score ${file}`);
		console.log("rescored site/demo.mp4 and site/demo.webm");
		await quit(0);
	}

	if (process.env.STILLS) {
		const dir = mkdtempSync(join(tmpdir(), "odin-trailer-stills-"));
		for (const t of process.env.STILLS.split(",").map(Number)) {
			await page(`render(${t})`);
			const { data } = await send("Page.captureScreenshot", { format: "png" });
			writeFileSync(join(dir, `${t}.png`), Buffer.from(data ?? "", "base64"));
		}
		console.log(`saved stills in ${dir}`);
		await quit(0);
	}

	const webm = encoder(
		findFfmpeg(),
		[
			"-c:v",
			"libvpx-vp9",
			"-b:v",
			"0",
			"-crf",
			"33",
			"-deadline",
			"good",
			"-cpu-used",
			"2",
			"-row-mt",
			"1",
		],
		"demo.webm",
	);
	const mp4 = encoder(
		process.env.FFMPEG_MP4 ?? "ffmpeg",
		[
			"-c:v",
			"libx264",
			"-profile:v",
			"high",
			"-pix_fmt",
			"yuv420p",
			"-crf",
			"22",
			"-preset",
			"slow",
			"-movflags",
			"+faststart",
		],
		"demo.mp4",
		music,
	);
	// No ffmpeg with libx264: the webm alone.
	let mp4Alive = true;
	mp4.closed.then(() => {
		mp4Alive = false;
	});
	mp4.stdin?.on("error", () => {
		mp4Alive = false;
	});

	const frames = Math.round(duration * FPS);
	for (let i = 0; i <= frames; i++) {
		const t = i / FPS;
		await page(`render(${t})`);
		const { data } = await send("Page.captureScreenshot", {
			format: "jpeg",
			quality: 95,
		});
		const jpeg = Buffer.from(data ?? "", "base64");
		webm.stdin?.write(jpeg);
		if (mp4Alive) mp4.stdin?.write(jpeg);
		if (Math.abs(t - POSTER_AT) < 0.5 / FPS)
			writeFileSync(join(SITE, "demo.jpg"), jpeg);
		if (i % (FPS * 5) === 0) console.log(`${Math.round(t)}s / ${duration}s`);
	}
	console.log(`${frames + 1} frames`);
	webm.stdin?.end();
	mp4.stdin?.end();
	if ((await webm.closed) !== 0) throw new Error("the webm encode failed");
	const mp4Saved = (await mp4.closed) === 0;
	// Playwright's ffmpeg has no audio encoder: the full ffmpeg adds the score to the webm.
	const withAudio = mp4Saved && score("demo.webm", music);
	console.log(
		`saved site/demo.webm${withAudio ? ", with the score" : ", silent"}`,
	);
	console.log(
		mp4Saved
			? "saved site/demo.mp4, with the score"
			: "skip site/demo.mp4: no ffmpeg with libx264 (set FFMPEG_MP4)",
	);
	console.log("saved site/demo.jpg");
	await quit(0);
} catch (error) {
	console.error(`FAIL ${(error as Error).message}\n`, log.slice(-2000));
	await quit(1);
}
