import { describe, expect, it } from "bun:test";
import { driveKind, driveSharedFiles } from "./feeds";

const NOW = Date.parse("2026-03-20T12:00:00Z");

describe("driveSharedFiles", () => {
	it("keeps the last 14 days of shares and names the kind and sharer", async () => {
		let asked = "";
		const rows = await driveSharedFiles(async (path) => {
			asked = path;
			return Response.json({
				files: [
					{
						id: "a",
						name: "Plan",
						mimeType: "application/vnd.google-apps.document",
						webViewLink: "https://docs.example.com/a",
						sharedWithMeTime: "2026-03-19T09:00:00Z",
						sharingUser: { displayName: "Riley Jones" },
					},
					{
						id: "old",
						name: "Last year",
						sharedWithMeTime: "2026-02-01T09:00:00Z",
					},
					{ id: "never", name: "No share time" },
				],
			});
		}, NOW);
		expect(asked).toContain("sharedWithMe");
		expect(rows).toEqual([
			{
				id: "a",
				url: "https://docs.example.com/a",
				name: "Plan",
				kind: "Document",
				sharedBy: "Riley Jones",
				sharedAt: "2026-03-19T09:00:00Z",
				modified: null,
			},
		]);
	});

	it("turns a refused token into a reconnect error", async () => {
		await expect(
			driveSharedFiles(async () => new Response("no", { status: 401 }), NOW),
		).rejects.toThrow(/reconnect Google Drive/);
	});
});

describe("driveKind", () => {
	it("says what a file is in a word", () => {
		expect(driveKind("application/vnd.google-apps.spreadsheet")).toBe(
			"Spreadsheet",
		);
		expect(driveKind("application/pdf")).toBe("PDF");
		expect(driveKind("image/png")).toBe("Image");
		expect(driveKind(undefined)).toBe("File");
	});
});
