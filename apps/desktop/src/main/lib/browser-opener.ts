/**
 * How a consent screen gets opened. Overridable, and lazily resolved, so no
 * module here imports electron at load time: a static `import { shell } from
 * "electron"` makes the test file fail to load in a full-suite run, because
 * something earlier in the run has already pulled in the real electron and the
 * mock no longer applies. Tests pass their own opener.
 */
export type BrowserOpener = (url: string) => Promise<void>;

export const openInBrowser: BrowserOpener = async (url) => {
	const { shell } = await import("electron");
	await shell.openExternal(url);
};
