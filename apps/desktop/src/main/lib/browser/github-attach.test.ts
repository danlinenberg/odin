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
		).toEqual({
			error: "x.svg: only png, jpg and gif images, or mp4, mov and webm videos",
		});
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
	test("each form GitHub writes (image Markdown, <img>, a video's own line), in order, and nothing else", () => {
		const markdown = [
			"Uploading...",
			"![home](https://github.com/user-attachments/assets/1a2b-3c)",
			'<img width="800" alt="modal" src="https://github.com/user-attachments/assets/4d5e-6f" />',
			"![elsewhere](https://example.com/x.png)",
			"https://github.com/user-attachments/assets/7a8b-9c",
			"see https://github.com/user-attachments/assets/0d1e-2f inline",
		].join("\n");
		expect(attachmentLinks(markdown)).toEqual([
			"![home](https://github.com/user-attachments/assets/1a2b-3c)",
			'<img width="800" alt="modal" src="https://github.com/user-attachments/assets/4d5e-6f" />',
			"https://github.com/user-attachments/assets/7a8b-9c",
		]);
	});
});

describe("attachScript", () => {
	test("is one expression that hands each file its type", () => {
		const script = attachScript([{ name: "a.png", data: png }], ["image/png"]);
		expect(() => new Function(`return ${script}`)).not.toThrow();
		expect(script).toContain('"type":"image/png"');
	});

	test("drops the images on a comment box that has no file input", async () => {
		const link = "![a](https://github.com/user-attachments/assets/abc-123)";
		class FakeTransfer {
			files: unknown[] = [];
			items = { add: (file: unknown) => this.files.push(file) };
		}
		class FakeDragEvent {
			constructor(
				readonly type: string,
				readonly init: { dataTransfer: FakeTransfer },
			) {}
		}
		const seen: string[] = [];
		const box = {
			value: "draft",
			offsetParent: {},
			id: "new_comment_field",
			getAttribute: () => null,
			parentElement: { querySelector: () => null, parentElement: null },
			dispatchEvent(event: FakeDragEvent) {
				seen.push(event.type);
				if (event.type === "drop" && event.init.dataTransfer.files.length)
					this.value += `\n${link}`;
			},
		};
		class FakeTextArea {}
		Object.defineProperty(FakeTextArea.prototype, "value", {
			set(this: typeof box, value: string) {
				this.value = value;
			},
		});
		const run = new Function(
			"document",
			"DataTransfer",
			"DragEvent",
			"File",
			"HTMLTextAreaElement",
			"Event",
			`return ${attachScript([{ name: "a.png", data: png }], ["image/png"], 2000)}`,
		);
		const result = await run(
			{ querySelectorAll: () => [box] },
			FakeTransfer,
			FakeDragEvent,
			class {},
			FakeTextArea,
			class {},
		);
		expect(seen).toEqual(["dragenter", "dragover", "drop"]);
		expect(result).toEqual({ markdown: `draft\n${link}` });
	});
});
