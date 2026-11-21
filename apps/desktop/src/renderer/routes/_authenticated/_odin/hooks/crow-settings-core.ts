/**
 * Huginn's settings tool: the settings he may read and change, each by the
 * label its row shows in Settings, so a change he makes is the one a click
 * there would make. The table itself is in crow-settings.ts; this is the part
 * that reads, checks, asks and writes, kept free of the stores so it tests.
 */

export type SettingKind =
	| { type: "switch" }
	| { type: "number"; min: number; max: number; step: number; unit: string }
	| { type: "choice"; choices: () => string[] }
	| { type: "time" };

export interface HuginnSetting {
	/** Exactly the row's label in Settings (settings-index.ts). */
	label: string;
	kind: SettingKind;
	read: () => unknown | Promise<unknown>;
	/** Makes the change the way the row's control does, so it applies at once. */
	write: (value: unknown) => unknown | Promise<unknown>;
	/**
	 * Turning it on loosens what sessions may do with nobody watching, so the
	 * window asks you first, and nothing changes unless you say yes there.
	 */
	asksFirst?: boolean;
	/** False while its row isn't on screen (a feature that is off). */
	shown?: () => boolean;
}

export interface SettingsContext {
	settings: HuginnSetting[];
	/** Settings → <screen> › <section> for a label. */
	whereIs: (label: string) => string;
	/** Asks in the window; true only when you agreed. */
	confirm: (question: string) => Promise<boolean>;
	/** Tells you in the window what changed. */
	announce: (text: string) => void;
}

/** A value as Settings shows it: on/off, "3 hours", a theme's name. */
export function formatValue(kind: SettingKind, value: unknown): string {
	if (kind.type === "switch") return value ? "on" : "off";
	if (kind.type === "number") return `${value} ${kind.unit}`;
	return String(value);
}

const ON = new Set(["on", "true", "yes", "1", "enabled", "enable"]);
const OFF = new Set(["off", "false", "no", "0", "disabled", "disable"]);

/** The typed value for a setting, or why the text isn't one. */
export function parseValue(
	kind: SettingKind,
	text: string,
): { value: unknown } | { error: string } {
	const raw = text.trim();
	if (kind.type === "switch") {
		const word = raw.toLowerCase();
		if (ON.has(word)) return { value: true };
		if (OFF.has(word)) return { value: false };
		return { error: "It's a switch: value=on or value=off." };
	}
	if (kind.type === "number") {
		const digits = raw.replace(/[^\d.+-]/g, "");
		const number = Number(digits);
		if (!/\d/.test(digits) || !Number.isFinite(number))
			return { error: `It's a number of ${kind.unit}.` };
		if (number < kind.min || number > kind.max)
			return {
				error: `It goes from ${kind.min} to ${kind.max} ${kind.unit}.`,
			};
		const snapped = Math.round(number / kind.step) * kind.step;
		return { value: Number(snapped.toFixed(4)) };
	}
	if (kind.type === "time") {
		const match = raw.match(/^(\d{1,2}):(\d{2})$/);
		const hours = Number(match?.[1]);
		const minutes = Number(match?.[2]);
		if (!match || hours > 23 || minutes > 59)
			return { error: "It's a time of day, HH:MM (24-hour)." };
		return {
			value: `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`,
		};
	}
	const choices = kind.choices();
	const pick = choices.find(
		(choice) => choice.toLowerCase() === raw.toLowerCase(),
	);
	return pick
		? { value: pick }
		: { error: `Pick one of: ${choices.join(", ")}.` };
}

const describeKind = (kind: SettingKind) => {
	if (kind.type === "switch") return "on/off";
	if (kind.type === "number") return `${kind.min}-${kind.max} ${kind.unit}`;
	if (kind.type === "time") return "HH:MM";
	return kind.choices().join(" | ");
};

const visible = (ctx: SettingsContext) =>
	ctx.settings.filter((setting) => setting.shown?.() ?? true);

/** The setting a name means: its exact label first, then a label holding every word. */
export function findSetting(
	ctx: SettingsContext,
	name: string,
): HuginnSetting | undefined {
	const wanted = name.trim().toLowerCase();
	if (!wanted) return undefined;
	const shown = visible(ctx);
	const exact = shown.find((s) => s.label.toLowerCase() === wanted);
	if (exact) return exact;
	const words = wanted.split(/\s+/);
	const close = shown.filter((s) =>
		words.every((word) => s.label.toLowerCase().includes(word)),
	);
	return close.length === 1 ? close[0] : undefined;
}

/**
 * action=settings: every setting Huginn may change, where it is, what it is
 * now and what it takes. `q` keeps the ones whose label or place mentions it.
 */
export async function listSettings(
	ctx: SettingsContext,
	q = "",
): Promise<string> {
	const needle = q.trim().toLowerCase();
	const rows = await Promise.all(
		visible(ctx)
			.filter(
				(s) =>
					!needle ||
					`${s.label} ${ctx.whereIs(s.label)}`.toLowerCase().includes(needle),
			)
			.map(async (s) => {
				const now = formatValue(s.kind, await s.read());
				const asks = s.asksFirst
					? " - asks the user in Odin before turning on"
					: "";
				return `${s.label} (${ctx.whereIs(s.label)}): ${now} [${describeKind(s.kind)}]${asks}`;
			}),
	);
	if (!rows.length) return `No setting I can change mentions "${q}".`;
	return `${rows.join("\n")}\nChange one with action=setting name=<label> value=<new value>. Anything not listed (sign-ins, connections, tokens, the remote host, auto-start, shortcuts) is the user's to change in Settings.`;
}

/**
 * action=setting: change one setting by its label, as its control in Settings
 * would, and say what changed. One that loosens what sessions may do alone
 * asks in the window first.
 */
export async function changeSetting(
	ctx: SettingsContext,
	args: Record<string, string>,
): Promise<string> {
	const name = args.name ?? "";
	const setting = findSetting(ctx, name);
	if (!setting)
		return `No setting I can change is called "${name}". List them with action=settings. Sign-ins, connections, tokens, the remote host, auto-start and shortcuts are for the user to change in Settings.`;
	if (args.value === undefined)
		return `Need value: ${describeKind(setting.kind)}.`;
	const parsed = parseValue(setting.kind, args.value);
	if ("error" in parsed) return `${setting.label}: ${parsed.error}`;
	const where = ctx.whereIs(setting.label);
	const before = await setting.read();
	const from = formatValue(setting.kind, before);
	const to = formatValue(setting.kind, parsed.value);
	if (from === to) return `${setting.label} (${where}) is already ${to}.`;
	if (setting.asksFirst && parsed.value === true) {
		const agreed = await ctx.confirm(
			`Huginn wants to turn on "${setting.label}" (${where}).`,
		);
		if (!agreed)
			return `The user said no in Odin, so ${setting.label} stays ${from}. Don't ask again unless they bring it up.`;
	}
	await setting.write(parsed.value);
	ctx.announce(`Huginn changed ${setting.label}: ${from} → ${to}`);
	return `Changed ${setting.label} (${where}) from ${from} to ${to}. It applies now.`;
}
