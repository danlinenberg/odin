import type { AnyRouter } from "@trpc/server";
import { z } from "zod";

/**
 * The raven's way to every operation main can do: the app's own tRPC router,
 * listed and called by path. The board's renderer state goes through the
 * renderer instead (useCrow's state/set/open actions).
 */
let appRouter: AnyRouter | undefined;

export const setOdinApiRouter = (router: AnyRouter) => {
	appRouter = router;
};

/** Long answers (a whole settings blob, a transcript) are cut here. */
const MAX_REPLY = 30_000;

export const clip = (text: string) =>
	text.length > MAX_REPLY
		? `${text.slice(0, MAX_REPLY)}\n... cut at ${MAX_REPLY} characters.`
		: text;

type ProcedureDef = {
	_def: { type: "query" | "mutation" | "subscription"; inputs: unknown[] };
};

const procedures = () =>
	Object.entries(
		(appRouter?._def.procedures ?? {}) as Record<string, ProcedureDef>,
	);

/** What a procedure takes, as compact JSON Schema - or "no input". */
function describeInput(def: ProcedureDef["_def"]): string {
	const schema = def.inputs[0];
	if (!schema) return "no input";
	try {
		const json = z.toJSONSchema(schema as z.ZodType, {
			unrepresentable: "any",
		});
		const { $schema: _, ...rest } = json as Record<string, unknown>;
		return JSON.stringify(rest);
	} catch {
		return "input (schema not printable)";
	}
}

/** `query|mutation path - input`, one per line; `q` filters by path. */
export function listProcedures(q = ""): string {
	const needle = q.toLowerCase();
	const lines = procedures()
		.filter(
			([path, p]) =>
				p._def.type !== "subscription" && path.toLowerCase().includes(needle),
		)
		.map(([path, p]) => `${p._def.type} ${path} - ${describeInput(p._def)}`);
	return lines.length ? clip(lines.join("\n")) : `No procedure matches "${q}".`;
}

/** Runs one procedure as main would for the renderer; the result as JSON. */
export async function callProcedure(
	path: string,
	input?: string,
): Promise<string> {
	if (!appRouter) return "Odin's API isn't up yet.";
	const def = procedures().find(([name]) => name === path)?.[1]?._def;
	if (!def) return `No procedure "${path}" - list them with action=api.`;
	if (def.type === "subscription") return "Subscriptions can't be called.";
	// The window holds these stores and writes them back over a change made
	// here: the call reported success and the theme stayed dark.
	if (path.startsWith("uiState.") && def.type === "mutation")
		return "The window owns this state - change it with action=state / action=run (e.g. store=theme fn=setTheme), or the window writes it back.";
	let parsed: unknown;
	try {
		parsed = input ? JSON.parse(input) : undefined;
	} catch {
		return "input must be JSON.";
	}
	// biome-ignore lint/suspicious/noExplicitAny: a caller is a proxy walked by path
	let fn: any = appRouter.createCaller({});
	for (const part of path.split(".")) fn = fn[part];
	try {
		const result = await fn(parsed);
		return clip(
			result === undefined ? "Done." : JSON.stringify(result, null, 1),
		);
	} catch (error) {
		return `Failed: ${error instanceof Error ? error.message : String(error)}`;
	}
}
