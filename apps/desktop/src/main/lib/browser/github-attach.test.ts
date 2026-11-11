import { describe, expect, mock, test } from "bun:test";

mock.module("electron", () => ({ BrowserWindow: class {}, session: {} }));

const { attachmentLinks, attachScript, parseAttachRequest } = await import(
	"./github-attach"
);

const png = Buffer.from("png").toString("base64");

describe("parseAttachRequest", () => {
	test("a PR and its images, each with the type its extension says", () => {
		expect(
			parseAttachRequest({
				repo: "acme/submitter-app-electron",
				number: "1234",
				files: [
					{ name: "home.png", data: png },
					{ name: "modal.JPG", data: png },
				],
			}),
		).toEqual({
			request: {
				repo: "acme/submitter-app-electron",
				number: 1234,
				files: [
					{ name: "home.png", data: png },
					{ name: "modal.JPG", data: png },
				],
			},
			types: ["image/png", "image/jpeg"],
		});
	});

	test("refuses what GitHub or a PR page can't take", () => {
		const ok = {
			repo: "a/b",
			number: 1,
			files: [{ name: "x.png", data: png }],
		};
		expect(parseAttachRequest({ ...ok, repo: "../x" })).toEqual({
			error: "repo must be owner/name",
		});
		expect(parseAttachRequest({ ...ok, number: 0 })).toEqual({
			error: "number must be the PR number",
		});
		expect(parseAttachRequest({ ...ok, files: [] })).toEqual({
			error: "files must list at least one image",
		});
		expect(
			parseAttachRequest({ ...ok, files: [{ name: "x.svg", data: png }] }),
		).toEqual({ error: "x.svg: only png, jpg and gif images" });
		expect(
			parseAttachRequest({
				...ok,
				files: Array.from({ length: 11 }, () => ok.files[0]),
			}),
		).toEqual({ error: "at most 10 images at a time" });
		expect(
			parseAttachRequest({
				...ok,
				files: [
					{
						name: "big.png",
						data: Buffer.alloc(11 * 1024 * 1024).toString("base64"),
					},
				],
			}),
		).toEqual({ error: "big.png: over 10 MB" });
	});
});

describe("attachmentLinks", () => {
	test("both forms GitHub writes, in order, and nothing else", () => {
		const markdown = [
			"Uploading...",
			"![home](https://github.com/user-attachments/assets/1a2b-3c)",
			'<img width="800" alt="modal" src="https://github.com/user-attachments/assets/4d5e-6f" />',
			"![elsewhere](https://example.com/x.png)",
		].join("\n");
		expect(attachmentLinks(markdown)).toEqual([
			"![home](https://github.com/user-attachments/assets/1a2b-3c)",
			'<img width="800" alt="modal" src="https://github.com/user-attachments/assets/4d5e-6f" />',
		]);
	});
});

describe("attachScript", () => {
	test("is one expression that hands each file its type", () => {
		const script = attachScript([{ name: "a.png", data: png }], ["image/png"]);
		expect(() => new Function(`return ${script}`)).not.toThrow();
		expect(script).toContain('"type":"image/png"');
	});
});
