import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	hostFileSources,
	hostFilesStore,
	rememberHostFiles,
} from "./host-files";

const dir = mkdtempSync(join(tmpdir(), "host-files-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("each copy on the host maps back to the laptop file it came from", async () => {
	hostFilesStore.path = join(dir, "nested", "host-files.json");
	await rememberHostFiles("odin-dan", [
		{
			local: "/Users/dan/.odin/attachments/shot.png",
			remote: ".odin/files/0-shot.png",
		},
	]);
	await rememberHostFiles("odin-dan", [
		{ local: "/tmp/clip.mp4", remote: ".odin/files/1700-0-clip.mp4" },
	]);
	expect(await hostFileSources()).toEqual({
		"/home/odin-dan/.odin/files/0-shot.png":
			"/Users/dan/.odin/attachments/shot.png",
		"/home/odin-dan/.odin/files/1700-0-clip.mp4": "/tmp/clip.mp4",
	});
});

test("two launches at once both keep their entries", async () => {
	hostFilesStore.path = join(dir, "both.json");
	await Promise.all([
		rememberHostFiles("u", [
			{ local: "/a.png", remote: ".odin/files/0-a.png" },
		]),
		rememberHostFiles("u", [
			{ local: "/b.png", remote: ".odin/files/0-b.png" },
		]),
	]);
	expect(Object.keys(await hostFileSources()).sort()).toEqual([
		"/home/u/.odin/files/0-a.png",
		"/home/u/.odin/files/0-b.png",
	]);
});

test("a missing or broken store reads as empty, and takes new entries", async () => {
	hostFilesStore.path = join(dir, "missing.json");
	expect(await hostFileSources()).toEqual({});
	hostFilesStore.path = join(dir, "broken.json");
	writeFileSync(hostFilesStore.path, "{not json");
	expect(await hostFileSources()).toEqual({});
	await rememberHostFiles("root", [
		{ local: "/a.png", remote: ".odin/files/0-a.png" },
	]);
	expect(await hostFileSources()).toEqual({
		"/root/.odin/files/0-a.png": "/a.png",
	});
});

test("only the newest thousand copies are kept", async () => {
	hostFilesStore.path = join(dir, "cap.json");
	await rememberHostFiles(
		"u",
		Array.from({ length: 1001 }, (_, i) => ({
			local: `/shot-${i}.png`,
			remote: `.odin/files/${i}-shot.png`,
		})),
	);
	const sources = await hostFileSources();
	expect(Object.keys(sources)).toHaveLength(1000);
	expect(sources["/home/u/.odin/files/0-shot.png"]).toBeUndefined();
	expect(sources["/home/u/.odin/files/1000-shot.png"]).toBe("/shot-1000.png");
});
