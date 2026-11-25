import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { builtInThemes, lightTheme } from "shared/themes/built-in";

/**
 * UI rules that broke before and are cheap to hold with a scan: keyboard
 * focus you can see, icon buttons a screen reader can name, one font-size
 * scale, and text colours that pass WCAG AA (4.5:1). The icon-set rule lives
 * in biome.jsonc (noRestrictedImports).
 */

const repo = join(import.meta.dir, "../../..");
const roots = ["apps/desktop/src/renderer", "packages/ui/src"].map((r) =>
	join(repo, r),
);

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory())
			return name === "node_modules" ? [] : sourceFiles(path);
		return /\.tsx?$/.test(name) && !/\.(test|stories)\./.test(name)
			? [path]
			: [];
	});
}

const files = roots.flatMap(sourceFiles).map((path) => ({
	path: relative(repo, path),
	text: readFileSync(path, "utf8"),
}));

const lineOf = (text: string, index: number) =>
	text.slice(0, index).split("\n").length;

describe("UI rules", () => {
	test("buttons and selects that drop the outline show a focus-visible one", () => {
		const bad: string[] = [];
		for (const { path, text } of files) {
			for (const m of text.matchAll(/[^\n]*\boutline-none\b[^\n]*/g)) {
				if (/focus(-visible|-within)?:|\bring\b/.test(m[0])) continue;
				const tag = [...text.slice(0, m.index).matchAll(/<([a-zA-Z.]+)/g)].at(
					-1,
				)?.[1];
				if (tag === "button" || tag === "select" || tag === "a")
					bad.push(`${path}:${lineOf(text, m.index)} <${tag}>`);
			}
		}
		expect(bad).toEqual([]);
	});

	test("an icon-only button has an accessible name", () => {
		const bad: string[] = [];
		// A button whose only child is an icon (react-icons or a *Icon component).
		const button =
			/<(button|Button)\b((?:[^>{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)>\s*(<(?:(?:Lu|Fa|Si)[A-Z]\w*|\w*Icon)\b[^<>]*\/>)\s*<\/\1>/g;
		for (const { path, text } of files) {
			for (const m of text.matchAll(button)) {
				if (/aria-label|aria-labelledby|title=|\{\.\.\./.test(m[2])) continue;
				bad.push(`${path}:${lineOf(text, m.index)}`);
			}
		}
		expect(bad).toEqual([]);
	});

	test("font sizes are whole pixels, 10px or more", () => {
		const bad: string[] = [];
		for (const { path, text } of files) {
			for (const m of text.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) {
				const px = Number(m[1]);
				if (!Number.isInteger(px) || px < 10)
					bad.push(`${path}:${lineOf(text, m.index)} ${m[0]}`);
			}
		}
		expect(bad).toEqual([]);
	});
});

// Relative luminance (WCAG 2) of a #rrggbb or oklch(L C H) colour.
function luminance(color: string): number {
	const toLinear = (c: number) =>
		c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	const hex = color.match(/^#([0-9a-f]{6})$/i);
	let rgb: number[];
	if (hex) {
		rgb = [0, 2, 4].map((i) =>
			toLinear(Number.parseInt(hex[1].slice(i, i + 2), 16) / 255),
		);
	} else {
		const ok = color.match(/^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/);
		if (!ok) throw new Error(`can't read colour ${color}`);
		const [L, C, H] = ok.slice(1).map(Number);
		const a = C * Math.cos((H * Math.PI) / 180);
		const b = C * Math.sin((H * Math.PI) / 180);
		const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
		const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
		const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
		rgb = [
			4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
			-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
			-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
		].map((c) => Math.min(Math.max(c, 0), 1));
	}
	return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

describe("text contrast", () => {
	test("the luminance maths agrees with WCAG", () => {
		expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 5);
		expect(contrast("oklch(1 0 0)", "oklch(0 0 0)")).toBeCloseTo(21, 2);
	});

	test("every built-in theme's muted text reads at 4.5:1 on its surfaces", () => {
		for (const { name, ui } of builtInThemes)
			for (const surface of [ui.background, ui.card, ui.muted])
				expect([name, contrast(ui.mutedForeground, surface) >= 4.5]).toEqual([
					name,
					true,
				]);
	});

	// The dark faint token is held by odin-palette-contrast.test.ts.
	test("light faint text reads at 4.5:1 on the light surfaces", () => {
		const css = readFileSync(
			join(import.meta.dir, "renderer/globals.css"),
			"utf8",
		);
		const faint = [...css.matchAll(/--faint-foreground:\s*([^;]+);/g)].map(
			(m) => m[1].trim(),
		);
		expect(faint.length).toBe(2);
		const { ui } = lightTheme;
		for (const surface of [ui.background, ui.card, ui.muted])
			expect(contrast(faint[1], surface)).toBeGreaterThanOrEqual(4.5);
	});
});
