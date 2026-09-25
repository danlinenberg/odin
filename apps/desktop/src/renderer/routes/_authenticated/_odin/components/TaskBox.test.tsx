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

	it("puts the title on its own line and the rest in the brief", () => {
		const html = renderToStaticMarkup(
			<TaskBox
				value={"Ship the fix\n\nit crashes on empty input"}
				onChange={() => {}}
				onSubmit={() => {}}
			/>,
		);
		// Title is an <input value>, brief is the <textarea>'s child text.
		expect(html).toContain('value="Ship the fix"');
		expect(html).toContain(">it crashes on empty input</textarea>");
	});

	it("opens on Medium for an empty box — the default needs no picking", () => {
		const html = renderToStaticMarkup(
			<TaskBox value="" onChange={() => {}} onSubmit={() => {}} />,
		);
		expect(html).toContain('<option value="2" selected="">Medium</option>');
		// "None" stopped being a level, so it isn't offered.
		expect(html).not.toContain("None");
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
		expect(html).toContain('value="/dev/odin"');
		expect(html).toContain("→ dev/odin");
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
		// Never resized (empty inline styles), never stored, or edited by hand —
		// all of which must leave the dialog on its class defaults.
		expect(parseSize(",")).toBeNull();
		expect(parseSize(null)).toBeNull();
		expect(parseSize("760px")).toBeNull();
		expect(parseSize("100%,50vh")).toBeNull();
	});
});
