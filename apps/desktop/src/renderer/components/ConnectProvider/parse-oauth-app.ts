/**
 * Picks one provider's OAuth app out of text pasted from another machine:
 * lines of its ~/.config/odin.json (`"airtableClientId": "..."`, the whole file
 * or a few lines, braces and trailing commas optional) or env lines
 * (`ODIN_AIRTABLE_CLIENT_ID=...`).
 */
const PARTS = [
	{ key: "clientId", json: "ClientId", env: "CLIENT_ID" },
	{ key: "clientSecret", json: "ClientSecret", env: "CLIENT_SECRET" },
	{ key: "redirectUrl", json: "RedirectUrl", env: "REDIRECT_URL" },
] as const;

export type PastedOAuthApp = {
	clientId: string;
	clientSecret: string;
	redirectUrl: string;
};

/** The app when all three parts are there, else the odin.json keys missing. */
export function parseOAuthApp(
	provider: string,
	text: string,
): { app: PastedOAuthApp | null; missing: string[] } {
	const found: Partial<PastedOAuthApp> = {};
	const missing: string[] = [];
	for (const part of PARTS) {
		const jsonKey = `${provider}${part.json}`;
		const envKey = `ODIN_${provider.toUpperCase()}_${part.env}`;
		const json = text.match(
			new RegExp(`"${jsonKey}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`),
		);
		const env = text.match(
			new RegExp(`^\\s*(?:export\\s+)?${envKey}\\s*=\\s*(.*)$`, "m"),
		);
		let value: string | undefined;
		if (json) value = JSON.parse(json[1]) as string;
		else if (env) value = env[1].trim().replace(/^(["'])(.*)\1$/, "$2");
		if (value?.trim()) found[part.key] = value.trim();
		else missing.push(jsonKey);
	}
	return missing.length
		? { app: null, missing }
		: { app: found as PastedOAuthApp, missing };
}
