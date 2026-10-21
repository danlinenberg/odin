import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	isAttachmentLine,
	joinAttachments,
	PriorityChip,
	parseSize,
	splitAttachments,
	TaskBox,
} from "./TaskBox";

describe("TaskBox", () => {
	it("shows the level the typed !s mean, so the picker can't lie", () => {
		const html = renderToStaticMarkup(
			<TaskBox
				value="!! Ship the fix"
				onChange={() => {}}
				onSubmit={() => {}}
			/>,
		);
		// The <select> is a mirror of the text: "!!" reads as Medium.
		expect(html).toContain('<option value="2" selected="">Medium</option>');
		expect(html).toContain("!! Ship the fix");
	});

	it("keeps the title and the brief in one textbox", () => {
		const html = renderToStaticMarkup(
			<TaskBox
				value={"Ship the fix\n\nit crashes on empty input"}
				onChange={() => {}}
				onSubmit={() => {}}
			/>,
		);
		expect(html.match(/<textarea/g)).toHaveLength(1);
		expect(html).not.toContain("<input");
		expect(html).toContain(
			">Ship the fix\n\nit crashes on empty input</textarea>",
		);
	});

	it("opens on Medium for an empty box - the default needs no picking", () => {
		const html = renderToStaticMarkup(
			<TaskBox value="" onChange={() => {}} onSubmit={() => {}} />,
		);
		expect(html).toContain('<option value="2" selected="">Medium</option>');
		// "None" stopped being a level, so it isn't offered.
		expect(html).not.toContain("None");
	});

	it("shows a submit button, off until there's a title", () => {
		const html = (value: string) =>
			renderToStaticMarkup(
				<TaskBox
					value={value}
					submitLabel="Add task"
					onChange={() => {}}
					onSubmit={() => {}}
				/>,
			);
		expect(html("")).toMatch(/<button[^>]*disabled=""[^>]*>Add task<\/button>/);
		expect(html("Ship the fix")).not.toMatch(/disabled=""[^>]*>Add task/);
	});

	it("offers a Repo field showing the checkout already picked", () => {
		const html = renderToStaticMarkup(
			<TaskBox
				value="Ship the fix"
				repos={["/dev/odin", "/dev/imagen"]}
				repo="/dev/odin"
				onRepoChange={() => {}}
				onChange={() => {}}
				onSubmit={() => {}}
			/>,
		);
		expect(html).toContain('aria-label="Repo"');
		// Shown by its short name, the full path on hover.
		expect(html).toContain('value="dev/odin"');
		expect(html).toContain('title="/dev/odin"');
	});

	it("shows recent repos as one-click picks, the picked one pressed", () => {
		const html = renderToStaticMarkup(
			<TaskBox
				value="Ship the fix"
				repos={["/dev/odin", "/dev/imagen"]}
				repo="/dev/odin"
				onRepoChange={() => {}}
				recentRepos={["/dev/odin", "/dev/imagen"]}
				onChange={() => {}}
				onSubmit={() => {}}
			/>,
		);
		expect(html).toContain("Recent");
		expect(html).toMatch(/aria-pressed="true"[^>]*>dev\/odin<\/button>/);
		expect(html).toMatch(/aria-pressed="false"[^>]*>dev\/imagen<\/button>/);
	});

	it("offers saved docs by title, keyed by their path", () => {
		const html = renderToStaticMarkup(
			<TaskBox
				value="Ship the fix"
				docs={[{ title: "Pricing ideas", path: "/h/.odin/docs/pricing.md" }]}
				onChange={() => {}}
				onSubmit={() => {}}
			/>,
		);
		expect(html).toContain('aria-label="Doc"');
		expect(html).toContain(
			'<option value="/h/.odin/docs/pricing.md">Pricing ideas</option>',
		);
	});
});

describe("TaskBox attachments", () => {
	const shot = "/Users/dan/.odin/attachments/1792569414089-rp3i3r.png";

	it("shows a pasted image as a chip under the text, not as a line in it", () => {
		const html = renderToStaticMarkup(
			<TaskBox
				value={`Ship the fix\n\n${shot}`}
				onChange={() => {}}
				onSubmit={() => {}}
			/>,
		);
		expect(html).toContain(">Ship the fix</textarea>");
		expect(html).not.toContain(`${shot}</textarea>`);
		// A pasted screenshot is served by name out of ~/.odin/attachments.
		expect(html).toContain(
			'<img src="odin-attachment://file/1792569414089-rp3i3r.png" alt="1792569414089-rp3i3r.png"',
		);
		expect(html).toContain('title="Remove 1792569414089-rp3i3r.png"');
	});

	it("shows a video or doc by name, and an image elsewhere by its path", () => {
		const html = renderToStaticMarkup(
			<TaskBox
				value={
					"Ship the fix\n\n/Users/dan/clip.mov\n/Users/dan/notes.md\n/Users/dan/Desktop/Shot 1.png"
				}
				onChange={() => {}}
				onSubmit={() => {}}
			/>,
		);
		expect(html).toContain(">Ship the fix</textarea>");
		expect(html).toContain("🎬");
		expect(html).toContain("clip.mov");
		expect(html).toContain("📄");
		expect(html).toContain("notes.md");
		expect(html).toContain(
			'src="odin-attachment://local/Users/dan/Desktop/Shot%201.png"',
		);
	});

	it("lets a screenshot with nothing typed be added or started on its own", () => {
		const html = renderToStaticMarkup(
			<TaskBox
				value={`\n\n${shot}`}
				submitLabel="Add task"
				onChange={() => {}}
				onSubmit={() => {}}
			/>,
		);
		// The box is empty, the chip is the task: the button stays on.
		expect(html).toContain("></textarea>");
		expect(html).not.toMatch(/disabled=""[^>]*>Add task/);
	});

	it("splits and joins the text and the paths without changing either", () => {
		for (const text of ["", "Ship the fix", "Ship the fix\n", "a\n\nb\n\n"]) {
			expect(splitAttachments(joinAttachments(text, [shot]))).toEqual({
				text,
				paths: [shot],
			});
			expect(splitAttachments(text)).toEqual({ text, paths: [] });
		}
		// The format the box always wrote: title, blank line, path.
		expect(splitAttachments(`Ship the fix\n\n${shot}`)).toEqual({
			text: "Ship the fix",
			paths: [shot],
		});
		// The same file twice is one attachment.
		expect(splitAttachments(`Ship the fix\n\n${shot}\n${shot}`).paths).toEqual([
			shot,
		]);
		// A path in the middle still comes out; the text keeps its other lines.
		expect(splitAttachments(`Ship the fix\n\n${shot}\n\nit crashes`)).toEqual({
			text: "Ship the fix\n\n\nit crashes",
			paths: [shot],
		});
	});

	it("takes only a bare path to a photo, video or doc as an attachment", () => {
		expect(isAttachmentLine(shot)).toBe(true);
		expect(isAttachmentLine(`  ${shot}  `)).toBe(true);
		expect(isAttachmentLine("~/.odin/attachments/shot.png")).toBe(true);
		expect(isAttachmentLine("C:\\Users\\dan\\shot.png")).toBe(true);
		expect(isAttachmentLine("/Users/dan/clip.mov")).toBe(true);
		expect(isAttachmentLine("/Users/dan/notes.md")).toBe(true);
		// Not a path on its own, a doc the picker cites, a URL, a plain file.
		expect(isAttachmentLine("see /Users/dan/shot.png")).toBe(false);
		expect(isAttachmentLine("Context doc: /h/.odin/docs/pricing.md")).toBe(
			false,
		);
		expect(isAttachmentLine("https://x.com/shot.png")).toBe(false);
		expect(isAttachmentLine("/Users/dan/report.pdf")).toBe(false);
	});
});

describe("PriorityChip", () => {
	it("names the level, and reads an unset one as Medium", () => {
		expect(renderToStaticMarkup(<PriorityChip priority={3} />)).toContain(
			"High",
		);
		expect(renderToStaticMarkup(<PriorityChip priority={1} />)).toContain(
			"Low",
		);
		expect(renderToStaticMarkup(<PriorityChip />)).toContain("Medium");
	});
});

describe("parseSize", () => {
	it("restores a size it wrote and ignores anything else", () => {
		// What the close handler writes: the element's two inline styles.
		expect(parseSize("760px,420px")).toEqual(["760px", "420px"]);
		// Never resized (empty inline styles), never stored, or edited by hand -
		// all of which must leave the dialog on its class defaults.
		expect(parseSize(",")).toBeNull();
		expect(parseSize(null)).toBeNull();
		expect(parseSize("760px")).toBeNull();
		expect(parseSize("100%,50vh")).toBeNull();
	});
});
