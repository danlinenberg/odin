import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PriorityChip, parseSize, TaskBox } from "./TaskBox";

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
