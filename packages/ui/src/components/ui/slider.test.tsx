import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Slider } from "./slider";

describe("Slider", () => {
	it("exposes the value, range and step to assistive tech", () => {
		const html = renderToStaticMarkup(
			<Slider
				aria-label="Text size"
				min={90}
				max={150}
				step={5}
				value={[110]}
			/>,
		);
		// The thumb is the slider for assistive tech, so the label sits on it.
		// Its aria-valuenow only appears once it has mounted and knows which
		// value it is, so static markup can't show it.
		const thumb = html.match(/<span[^>]*role="slider"[^>]*>/)?.[0];
		expect(thumb).toContain('aria-label="Text size"');
		expect(thumb).toContain('aria-valuemin="90"');
		expect(thumb).toContain('aria-valuemax="150"');
	});

	it("draws one thumb per value", () => {
		const one = renderToStaticMarkup(<Slider value={[1]} />);
		const two = renderToStaticMarkup(<Slider value={[1, 2]} />);
		expect(one.match(/role="slider"/g)).toHaveLength(1);
		expect(two.match(/role="slider"/g)).toHaveLength(2);
	});
});
