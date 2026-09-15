import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PriorityChip, TaskBox } from "./TaskBox";

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

	it("opens on Medium for an empty box — the default needs no picking", () => {
		const html = renderToStaticMarkup(
			<TaskBox value="" onChange={() => {}} onSubmit={() => {}} />,
		);
		expect(html).toContain('<option value="2" selected="">Medium</option>');
		// "None" stopped being a level, so it isn't offered.
		expect(html).not.toContain("None");
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
