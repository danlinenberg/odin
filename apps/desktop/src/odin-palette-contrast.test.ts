import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every Odin screen colours its text with the theme tokens in globals.css
 * (text-muted-foreground on bg-card, text-danger on bg-secondary, ...), so a
 * token nudged a shade darker turns unreadable everywhere at once. This holds
 * each text token to WCAG AA (4.5:1) against every dark surface it can sit on.
 */

const AA = 4.5;
// faint-foreground is for tags, separators and placeholders: WCAG's 3:1 floor
// for incidental text and UI parts, not body copy.
const HINT = 3;
const TEXT: Record<string, number> = {
	foreground: AA,
	"soft-foreground": AA,
	"muted-foreground": AA,
	primary: AA,
	working: AA,
	attention: AA,
	success: AA,
	danger: AA,
	"faint-foreground": HINT,
};
const SURFACES = ["background", "card", "popover", "secondary", "accent"];

// The first :root block is the built-in dark theme the app ships with.
const darkTokens = new Map(
	[
		...(readFileSync(join(import.meta.dir, "renderer/globals.css"), "utf8")
			.match(/:root \{([^}]*)\}/)?.[1]
			.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6});/g) ?? []),
	].map(([, name, hex]) => [name, hex]),
);

const srgb = (c: number) => {
	const v = c / 255;
	return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const rgb = (hex: string) => {
	const h = hex.slice(1);
	return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
};
const luminance = (hex: string) => {
	const [r, g, b] = rgb(hex).map(srgb) as [number, number, number];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
};

describe("odin palette", () => {
	test("reads every token it checks", () => {
		for (const name of [...Object.keys(TEXT), ...SURFACES])
			expect(darkTokens.get(name)).toMatch(/^#/);
	});

	test("every text token clears its floor on every surface", () => {
		const failures = Object.entries(TEXT).flatMap(([text, floor]) =>
			SURFACES.flatMap((bg) => {
				const ratio = contrast(
					darkTokens.get(text) as string,
					darkTokens.get(bg) as string,
				);
				return ratio < floor
					? [`${text} on ${bg} = ${ratio.toFixed(2)}:1 (< ${floor})`]
					: [];
			}),
		);
		expect(failures).toEqual([]);
	});
});
