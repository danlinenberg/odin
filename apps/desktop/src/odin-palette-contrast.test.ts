import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ODIN_DIR = join(import.meta.dir, "renderer/routes/_authenticated/_odin");

/**
 * The Odin UI writes its colours as inline Tailwind hexes, so nothing stops a
 * new shade from landing that nobody can read on the near-black background.
 * This walks the real class strings and holds every text colour to WCAG AA
 * (4.5:1) against whatever it actually sits on.
 */

const AA = 4.5;
// Surfaces a class string with no bg- of its own can end up on.
const SURFACES = ["#0a0a0c", "#111114", "#16161b"];

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
/** `bg-[#f0647a]/10` is a tint — flatten it onto the darkest surface. */
const flatten = (hex: string, alpha: number, over: string) => {
	const [r, g, b] = rgb(hex);
	const [br, bg, bb] = rgb(over);
	const mix = (f: number, k: number) => Math.round(f * alpha + k * (1 - alpha));
	return `#${[mix(r, br), mix(g, bg), mix(b, bb)]
		.map((v) => v.toString(16).padStart(2, "0"))
		.join("")}`;
};

function* tsxFiles(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) yield* tsxFiles(path);
		else if (entry.endsWith(".tsx")) yield path;
	}
}

const COLOR = /(?:([a-z-]+):)?(bg|text)-\[(#[0-9a-fA-F]{6})\](?:\/(\d+))?/g;

type Pair = { file: string; text: string; bg: string };

function findPairs(): Pair[] {
	const pairs: Pair[] = [];
	for (const file of tsxFiles(ODIN_DIR)) {
		const source = readFileSync(file, "utf8");
		// One quoted literal ~ one class string; conditional branches split apart.
		for (const [literal] of source.matchAll(/"[^"\n]*"|`[^`\n]*`/g)) {
			// A `hover:` text colour lands on the `hover:` background, never the
			// base one — so pair colours up by variant, not by class string.
			const bgs = new Map<string, string[]>();
			const texts: { variant: string; color: string }[] = [];
			for (const [, variant = "", kind, hex, alpha] of literal.matchAll(
				COLOR,
			)) {
				const color = alpha
					? flatten(hex, Number(alpha) / 100, SURFACES[0])
					: hex;
				if (kind === "bg")
					bgs.set(variant, [...(bgs.get(variant) ?? []), color]);
				else texts.push({ variant, color });
			}
			for (const { variant, color } of texts) {
				const under = bgs.get(variant) ?? bgs.get("") ?? SURFACES;
				for (const bg of under)
					pairs.push({
						file: file.slice(ODIN_DIR.length + 1),
						text: color,
						bg,
					});
			}
		}
	}
	return pairs;
}

describe("odin palette", () => {
	const pairs = findPairs();

	test("finds the class strings to check", () => {
		expect(pairs.length).toBeGreaterThan(100);
	});

	test("every text colour clears WCAG AA on its background", () => {
		const failures = pairs
			.filter((p) => contrast(p.text, p.bg) < AA)
			.map(
				(p) =>
					`${p.file}: ${p.text} on ${p.bg} = ${contrast(p.text, p.bg).toFixed(2)}:1`,
			);
		expect([...new Set(failures)]).toEqual([]);
	});
});
