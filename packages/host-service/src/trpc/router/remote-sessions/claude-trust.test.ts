import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markClaudeFolderTrusted } from "./claude-trust";

function tempFile(content?: string): string {
	const file = join(
		mkdtempSync(join(tmpdir(), "claude-trust-")),
		".claude.json",
	);
	if (content !== undefined) writeFileSync(file, content);
	return file;
}

describe("markClaudeFolderTrusted", () => {
	it("trusts the folder and keeps everything else", async () => {
		const file = tempFile(
			JSON.stringify({
				theme: "dark",
				projects: {
					"/other": { allowedTools: ["x"] },
					"/repo": { history: [1] },
				},
			}),
		);
		await markClaudeFolderTrusted("/repo", file);
		const config = JSON.parse(readFileSync(file, "utf8"));
		expect(config.theme).toBe("dark");
		expect(config.projects["/other"]).toEqual({ allowedTools: ["x"] });
		expect(config.projects["/repo"]).toEqual({
			history: [1],
			hasTrustDialogAccepted: true,
		});
	});

	it("creates the file when missing", async () => {
		const file = tempFile();
		await markClaudeFolderTrusted("/repo", file);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
			projects: { "/repo": { hasTrustDialogAccepted: true } },
		});
	});

	it("leaves a file it cannot parse alone", async () => {
		const file = tempFile("{not json");
		await markClaudeFolderTrusted("/repo", file);
		expect(readFileSync(file, "utf8")).toBe("{not json");
	});
});
