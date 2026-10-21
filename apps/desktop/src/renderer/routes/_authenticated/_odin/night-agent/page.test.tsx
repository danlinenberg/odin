import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_OFF_HOURS } from "renderer/stores/next-in-line-prompt";
import { NightAgentHero } from "./page";

const noop = () => {};

test("off: the hero still shows the switch, the window and the cap, so they can be set first", () => {
	const html = renderToStaticMarkup(
		<NightAgentHero
			offHours={DEFAULT_OFF_HOURS}
			started={0}
			lastEvent={undefined}
			onChange={noop}
			onToggle={noop}
		/>,
	);
	expect(html).toContain(">Off<");
	expect(html).toMatch(/role="switch"[^>]*aria-checked="false"/);
	expect(html).toMatch(/type="time"[^>]*value="23:00"/);
	expect(html).toMatch(/type="time"[^>]*value="07:00"/);
	expect(html).toMatch(/type="number"[^>]*value="8"/);
	expect(html).not.toContain("under Schedule");
});

test("on: the switch reads on, and the window and the cap show the saved values", () => {
	const html = renderToStaticMarkup(
		<NightAgentHero
			offHours={{
				...DEFAULT_OFF_HOURS,
				enabled: true,
				start: "22:30",
				end: "06:15",
				maxSessions: 12,
			}}
			started={3}
			lastEvent="Started one"
			onChange={noop}
			onToggle={noop}
		/>,
	);
	expect(html).toMatch(/Running until 06:15|Next run at 22:30/);
	expect(html).toMatch(/role="switch"[^>]*aria-checked="true"/);
	expect(html).toMatch(/type="time"[^>]*value="22:30"/);
	expect(html).toMatch(/type="time"[^>]*value="06:15"/);
	expect(html).toMatch(/type="number"[^>]*value="12"/);
	expect(html).toContain(">3<");
	expect(html).toContain("Started one");
});
