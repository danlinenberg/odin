import { expect, test } from "bun:test";
import { forSession } from "./host-files";

const message = {
	text: "see this",
	paths: ["/Users/dan/.odin/attachments/a.png"],
};
const copied = {
	text: "see this",
	paths: ["/home/ubuntu/.odin/files/1-a.png"],
};

test("a local session gets the phone's files where they are", async () => {
	let called = false;
	const toHost = async () => {
		called = true;
		return copied;
	};
	expect(await forSession({}, message, toHost)).toEqual(message);
	expect(await forSession(undefined, message, toHost)).toEqual(message);
	expect(called).toBe(false);
});

test("a session on the remote host gets copies of the files", async () => {
	expect(
		await forSession({ odinRemote: "host-1" }, message, async () => copied),
	).toEqual(copied);
});

test("a text-only reply to a remote session copies nothing", async () => {
	let called = false;
	const text = { text: "go on", paths: [] };
	await forSession({ odinRemote: "host-1" }, text, async () => {
		called = true;
		return text;
	});
	expect(called).toBe(false);
});

test("a host that is down fails the reply instead of sending a dead path", async () => {
	await expect(
		forSession({ odinRemote: "host-1" }, message, async () => {
			throw new Error("host unreachable");
		}),
	).rejects.toThrow("host unreachable");
});
