import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserWindow } from "electron";
import { fetchFile } from "./read-link";
import { hostFileSources } from "./remote-host/host-files";
import {
	DEFAULT_FRAMES,
	frameTimes,
	gridColumns,
	SHEET_WIDTH,
	timeLabel,
} from "./video-frames-plan";

/**
 * A video as one PNG an agent can read: frames at evenly spaced times, in a
 * grid, each labeled with its time. Claude can't open a video, and asking it
 * to run ffmpeg asks for something most machines don't have. Odin's own
 * Chromium decodes the video instead, so nothing is installed.
 */
export async function videoContactSheet(
	src: string,
	options: { count?: number; from?: number; to?: number } = {},
): Promise<Buffer> {
	const { path, cleanup } = await localVideo(src);
	try {
		return await renderSheet(path, options);
	} finally {
		await cleanup();
	}
}

/**
 * The video on this computer. A remote session names its host copy, which
 * maps back to the laptop file it came from; a Slack or Jira link is
 * downloaded with Odin's token.
 */
async function localVideo(
	src: string,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
	const none = async () => {};
	if (/^https?:\/\//.test(src)) {
		const file = await fetchFile(src);
		if (!file) throw new Error("Odin couldn't fetch that video.");
		const dir = await mkdtemp(join(tmpdir(), "odin-video-"));
		const path = join(dir, "video");
		await writeFile(path, Buffer.from(await file.arrayBuffer()));
		return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
	}
	if (existsSync(src)) return { path: src, cleanup: none };
	const copy = (await hostFileSources())[src];
	if (copy && existsSync(copy)) return { path: copy, cleanup: none };
	throw new Error(`No video at ${src}.`);
}

async function renderSheet(
	path: string,
	{
		count = DEFAULT_FRAMES,
		from,
		to,
	}: { count?: number; from?: number; to?: number },
): Promise<Buffer> {
	// A throwaway window: no preload, no node, nothing remote. webSecurity is
	// off so frames of a file:// video can be read back off the canvas (a
	// file:// page is its own opaque origin and would taint it).
	const window = new BrowserWindow({
		show: false,
		webPreferences: {
			sandbox: true,
			nodeIntegration: false,
			webSecurity: false,
			backgroundThrottling: false,
		},
	});
	const timer = setTimeout(() => window.destroy(), 120_000);
	const run = <T>(script: string): Promise<T> =>
		window.webContents.executeJavaScript(script);
	try {
		await window.loadURL("about:blank");
		const duration = await run<number>(
			LOAD_VIDEO.replace("__URL__", () =>
				JSON.stringify(pathToFileURL(path).href),
			),
		);
		const times = frameTimes(duration, count, from, to);
		const columns = gridColumns(times.length);
		const dataUrl = await run<string>(
			DRAW_SHEET.replace("__PARAMS__", () =>
				JSON.stringify({
					times,
					labels: times.map(timeLabel),
					columns,
					cellW: Math.floor(SHEET_WIDTH / columns),
				}),
			),
		);
		return Buffer.from(
			dataUrl.replace(/^data:image\/png;base64,/, ""),
			"base64",
		);
	} finally {
		clearTimeout(timer);
		if (!window.isDestroyed()) window.destroy();
	}
}

// Plain strings, not functions turned into source: a bundler can rewrite a
// function's body with helpers the throwaway page doesn't have.

/** Loads the video into the page and resolves its duration in seconds. */
const LOAD_VIDEO = `new Promise((resolve, reject) => {
	const video = document.createElement("video");
	video.muted = true;
	video.preload = "auto";
	video.onloadeddata = () => resolve(video.duration);
	video.onerror = () => reject(new Error("Odin can't decode this video - its codec isn't supported."));
	video.src = __URL__;
	window.video = video;
})`;

/** Seeks to each time, draws the frame into its cell with its time on it, and resolves the sheet as a PNG data URL. */
const DRAW_SHEET = `(async ({ times, labels, columns, cellW }) => {
	const video = window.video;
	const cellH = Math.round((cellW * video.videoHeight) / video.videoWidth);
	const canvas = document.createElement("canvas");
	canvas.width = cellW * columns;
	canvas.height = cellH * Math.ceil(times.length / columns);
	const ctx = canvas.getContext("2d");
	ctx.fillStyle = "#000";
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	const font = Math.max(12, Math.round(cellW / 22));
	const pad = Math.round(font / 3);
	ctx.font = "bold " + font + "px sans-serif";
	for (let i = 0; i < times.length; i++) {
		await new Promise((resolve) => {
			video.onseeked = resolve;
			video.currentTime = times[i];
		});
		const x = (i % columns) * cellW;
		const y = Math.floor(i / columns) * cellH;
		ctx.drawImage(video, x, y, cellW, cellH);
		ctx.fillStyle = "rgba(0,0,0,.7)";
		ctx.fillRect(x, y, ctx.measureText(labels[i]).width + pad * 2, font + pad * 2);
		ctx.fillStyle = "#fff";
		ctx.fillText(labels[i], x + pad, y + font + pad / 2);
		ctx.strokeStyle = "#000";
		ctx.strokeRect(x, y, cellW, cellH);
	}
	return canvas.toDataURL("image/png");
})(__PARAMS__)`;
