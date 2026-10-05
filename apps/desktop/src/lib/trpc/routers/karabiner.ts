import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { app } from "electron";
import { z } from "zod";
import { publicProcedure, router } from "..";

/**
 * Double-tap right command to open Odin from any app. Electron can't see a
 * modifier double-tap without a native key monitor, so the rule lives in
 * Karabiner-Elements, and Karabiner's own config file is the only record of
 * the setting. Karabiner reloads that file whenever it changes.
 */
const DESCRIPTION = "Double-tap right command to open Odin";
const TAPPED = "odin_right_command_tapped";
const CONFIG_PATH = join(homedir(), ".config/karabiner/karabiner.json");

interface KarabinerConfig {
	profiles: {
		selected?: boolean;
		complex_modifications?: { rules?: { description?: string }[] };
	}[];
}

/**
 * The first press sets a flag that any other key, or 500ms, clears. The
 * second press opens Odin only if it's released alone, so right command still
 * works as a modifier: ⌘C then ⌘V never opens anything.
 */
function doubleTapRule(command: string) {
	const tapped = (value: number) => ({ set_variable: { name: TAPPED, value } });
	const from = { key_code: "right_command", modifiers: { optional: ["any"] } };
	return {
		description: DESCRIPTION,
		manipulators: [
			{
				type: "basic",
				conditions: [{ type: "variable_if", name: TAPPED, value: 1 }],
				from,
				to: [{ key_code: "right_command" }],
				to_if_alone: [{ shell_command: command }],
			},
			{
				type: "basic",
				from,
				to: [tapped(1), { key_code: "right_command" }],
				to_delayed_action: {
					to_if_invoked: [tapped(0)],
					to_if_canceled: [tapped(0)],
				},
			},
		],
	};
}

/**
 * The dev bundle is a bare Electron that shows its welcome screen when opened
 * on its own, so dev goes through the launcher applet, which raises the dev
 * window or starts the dev stack.
 */
function openOdinCommand(): string {
	const bundle = app.isPackaged
		? resolve(process.execPath, "../../..")
		: "/Applications/Odin Dev.app";
	return `open '${bundle}'`;
}

function selectedProfile(config: KarabinerConfig) {
	const profile = config.profiles.find((p) => p.selected) ?? config.profiles[0];
	if (!profile) throw new Error("Karabiner has no profile");
	return profile;
}

export function hasDoubleTap(config: KarabinerConfig): boolean {
	const rules = selectedProfile(config).complex_modifications?.rules ?? [];
	return rules.some((r) => r.description === DESCRIPTION);
}

/** Appended after the rules already there, so a Kid lock above it still wins. */
export function withDoubleTap(
	config: KarabinerConfig,
	command: string | null,
): KarabinerConfig {
	const profile = selectedProfile(config);
	const others = (profile.complex_modifications?.rules ?? []).filter(
		(r) => r.description !== DESCRIPTION,
	);
	profile.complex_modifications = {
		...profile.complex_modifications,
		rules: command ? [...others, doubleTapRule(command)] : others,
	};
	return config;
}

/** null when Karabiner isn't set up. A file that won't parse throws, so it's never overwritten. */
function readConfig(): KarabinerConfig | null {
	let raw: string;
	try {
		raw = readFileSync(CONFIG_PATH, "utf8");
	} catch {
		return null;
	}
	return JSON.parse(raw) as KarabinerConfig;
}

export const createKarabinerRouter = () => {
	return router({
		doubleTap: publicProcedure.query(() => {
			const config = readConfig();
			return {
				available: config !== null,
				enabled: config ? hasDoubleTap(config) : false,
			};
		}),
		setDoubleTap: publicProcedure
			.input(z.object({ enabled: z.boolean() }))
			.mutation(({ input }) => {
				const config = readConfig();
				if (!config) throw new Error("Karabiner-Elements isn't set up");
				withDoubleTap(config, input.enabled ? openOdinCommand() : null);
				// Write-then-rename, so Karabiner never reloads a half-written file.
				const tmp = `${CONFIG_PATH}.odin-tmp`;
				writeFileSync(tmp, `${JSON.stringify(config, null, 4)}\n`);
				renameSync(tmp, CONFIG_PATH);
			}),
	});
};
