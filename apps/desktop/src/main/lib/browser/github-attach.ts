import { BrowserWindow, session } from "electron";
import { IN_APP_BROWSER_PARTITION } from "shared/constants";

/**
 * Screenshots on a PR, uploaded as me: GitHub has no API for a comment's
 * image attachments, so Odin opens the PR in a hidden window of its own
 * browser (signed in to GitHub there) and hands the images to the comment
 * box's file input - GitHub's own page uploads them, as a drag and drop
 * would - then reads the image links GitHub writes into the box and leaves the
 * box as it was. The caller posts the comment.
 */

export interface AttachFile {
	name: string;
	/** The image, base64. */
	data: string;
}

export interface AttachRequest {
	repo: string;
	number: number;
	files: AttachFile[];
}

const MAX_FILES = 10;
/** GitHub's own limit for an image in a comment. */
const MAX_BYTES = 10 * 1024 * 1024;
const TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
};

/** The request, checked, with each file's type; or why it can't be done. */
export function parseAttachRequest(
	body: unknown,
): { request: AttachRequest; types: string[] } | { error: string } {
	const { repo, number, files } = (body ?? {}) as Record<string, unknown>;
	if (
		typeof repo !== "string" ||
		!/^[A-Za-z0-9][\w-]*\/[\w.-]+$/.test(repo) ||
		/\/\.{1,2}$/.test(repo)
	)
		return { error: "repo must be owner/name" };
	const pr = Number(number);
	if (!Number.isInteger(pr) || pr < 1)
		return { error: "number must be the PR number" };
	if (!Array.isArray(files) || files.length === 0)
		return { error: "files must list at least one image" };
	if (files.length > MAX_FILES)
		return { error: `at most ${MAX_FILES} images at a time` };
	const types: string[] = [];
	for (const file of files) {
		const { name, data } = (file ?? {}) as Record<string, unknown>;
		if (typeof name !== "string" || typeof data !== "string" || !data)
			return { error: "each file needs a name and base64 data" };
		const type = TYPES[name.split(".").at(-1)?.toLowerCase() ?? ""];
		if (!type) return { error: `${name}: only png, jpg and gif images` };
		if (Buffer.byteLength(data, "base64") > MAX_BYTES)
			return { error: `${name}: over 10 MB` };
		types.push(type);
	}
	return {
		request: { repo, number: pr, files: files as AttachFile[] },
		types,
	};
}

/** The image links GitHub wrote, in the order they appear. */
export function attachmentLinks(markdown: string): string[] {
	return [
		...markdown.matchAll(
			/!\[[^\]]*\]\(https:\/\/github\.com\/user-attachments\/assets\/[\w-]+\)|<img [^>]*src="https:\/\/github\.com\/user-attachments\/assets\/[\w-]+"[^>]*>/g,
		),
	].map((match) => match[0]);
}

/**
 * The script the PR page runs: the comment box's file input gets the images,
 * then it waits for GitHub to write a link for each, and puts the box back.
 * Answers { markdown } or { error }.
 */
export function attachScript(
	files: AttachFile[],
	types: string[],
	timeoutMs = 120_000,
): string {
	const input = JSON.stringify(
		files.map((file, i) => ({ ...file, type: types[i] })),
	);
	return `(async (files, timeoutMs) => {
	const visible = (el) => el.offsetParent !== null;
	const findBox = () => [...document.querySelectorAll("textarea")].find((t) =>
		visible(t) && /comment|markdown/i.test([t.id, t.name, t.placeholder, t.getAttribute("aria-label")].join(" ")));
	let box = findBox();
	for (let i = 0; !box && i < 30; i++) {
		await new Promise((r) => setTimeout(r, 500));
		box = findBox();
	}
	if (!box) return { error: "no comment box on the PR page" };
	let input = null;
	for (let el = box.parentElement; el && !input; el = el.parentElement)
		input = el.querySelector('input[type="file"]');
	if (!input) return { error: "no file upload next to the comment box" };
	const before = box.value;
	const transfer = new DataTransfer();
	for (const file of files) {
		const bytes = Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0));
		transfer.items.add(new File([bytes], file.name, { type: file.type }));
	}
	input.files = transfer.files;
	input.dispatchEvent(new Event("change", { bubbles: true }));
	const links = /https:\\/\\/github\\.com\\/user-attachments\\/assets\\//g;
	for (const end = Date.now() + timeoutMs; Date.now() < end; ) {
		await new Promise((r) => setTimeout(r, 500));
		if ((box.value.match(links) ?? []).length >= files.length) {
			const markdown = box.value;
			const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
			set.call(box, before);
			box.dispatchEvent(new Event("input", { bubbles: true }));
			return { markdown };
		}
	}
	return { error: "GitHub did not finish the upload in time" };
})(${input}, ${timeoutMs})`;
}

const githubSession = () => session.fromPartition(IN_APP_BROWSER_PARTITION);

async function signedIn(): Promise<boolean> {
	const cookies = await githubSession().cookies.get({
		url: "https://github.com",
		name: "logged_in",
	});
	return cookies.some((cookie) => cookie.value === "yes");
}

/**
 * Shows GitHub's sign-in page in a window of Odin's browser and waits until
 * the sign-in lands (5 minutes at most). True when signed in.
 */
async function signIn(): Promise<boolean> {
	const win = new BrowserWindow({
		width: 520,
		height: 720,
		title: "Sign in to GitHub for Odin",
		webPreferences: { partition: IN_APP_BROWSER_PARTITION },
	});
	void win.loadURL("https://github.com/login");
	try {
		for (const end = Date.now() + 5 * 60_000; Date.now() < end; ) {
			if (win.isDestroyed()) return signedIn();
			if (await signedIn()) return true;
			await new Promise((r) => setTimeout(r, 2000));
		}
		return false;
	} finally {
		if (!win.isDestroyed()) win.close();
	}
}

export class AttachError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

/** Uploads the images to the PR's comment box as me; the image Markdown, one per file. */
export async function attachToPr(
	request: AttachRequest,
	types: string[],
): Promise<string[]> {
	if (!(await signedIn()) && !(await signIn()))
		throw new AttachError(
			"Odin's browser is not signed in to GitHub. Sign in in the window Odin opened on my computer, then retry.",
			401,
		);
	const win = new BrowserWindow({
		show: false,
		webPreferences: { partition: IN_APP_BROWSER_PARTITION },
	});
	try {
		await win.loadURL(
			`https://github.com/${request.repo}/pull/${request.number}`,
		);
		const result = (await win.webContents.executeJavaScript(
			attachScript(request.files, types),
			true,
		)) as { markdown?: string; error?: string };
		if (result.error) throw new AttachError(result.error, 502);
		const links = attachmentLinks(result.markdown ?? "");
		if (links.length < request.files.length)
			throw new AttachError("GitHub returned fewer images than sent", 502);
		return links;
	} finally {
		win.destroy();
	}
}
