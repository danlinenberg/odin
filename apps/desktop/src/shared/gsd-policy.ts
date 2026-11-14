/**
 * What GSD Mode may do by itself. Odin checks every command it is about to
 * run for a session in GSD Mode, and every yes/no check it would answer,
 * against these. Pure, so the chat and its tests read a command the same way.
 */
export type GsdAllow = {
	/** Merge a pull request or push to the default branch. */
	merge: boolean;
	/** Delete, overwrite or tear down something. */
	destructive: boolean;
	/** Touch credentials, permissions or protections. */
	sensitive: boolean;
};

export const GSD_ALLOW_NOTHING: GsdAllow = {
	merge: false,
	destructive: false,
	sensitive: false,
};

/** Off whatever the settings say: there is no way back from these. */
const NEVER: [RegExp, string][] = [
	[
		/\brm\s+(?:-\w+\s+)*-\w*[rR]\w*\s+(?:-\w+\s+)*(?:--\s+)?["']?(?:\/|~|\$HOME|\$\{HOME\})\/?\*?["']?(?:\s|;|&|\||$)/,
		"it deletes your home or root folder",
	],
	[
		/\bgit\s+push\b(?=.*(?:\s-f\b|--force))(?=.*\b(?:main|master)\b)/,
		"it force-pushes the default branch",
	],
	[
		/\b(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/,
		"it runs a download as a script",
	],
	[/\bmkfs(?:\.\w+)?\b|\bdd\b[^|;&]*\bof=\/dev\//, "it wipes a disk"],
];

const MERGE =
	/\bgh\s+pr\s+merge\b|\bglab\s+mr\s+merge\b|\/pulls\/\d+\/merge\b|\bgit\s+push\b[^|;&]*\b(?:main|master)\b|\bgit\s+merge\b/;

const DESTRUCTIVE = new RegExp(
	[
		String.raw`\brm\s+(?:-\w+\s+)*-\w*[rRf]`,
		String.raw`\bgit\s+(?:reset\s+--hard|clean\s+-\w*f|branch\s+-D|checkout\s+(?:--\s+)?\.|restore\s+\.|stash\s+(?:drop|clear)|worktree\s+remove)`,
		String.raw`\bgit\s+push\b[^|;&]*(?:\s-f\b|--force|--delete|\s:\w)`,
		String.raw`\bgh\s+(?:repo|release|workflow|run|secret|variable)\s+delete\b|\bgh\s+(?:pr|issue)\s+close\b`,
		String.raw`\b(?:drop|truncate)\s+(?:table|database|schema)\b|\bdelete\s+from\b`,
		String.raw`\bkubectl\s+delete\b|\bhelm\s+(?:uninstall|delete)\b`,
		String.raw`\bterraform\s+(?:destroy|apply)\b`,
		String.raw`\baws\s+\S+\s+(?:delete|terminate|remove|purge|deregister)-|\baws\s+s3\s+(?:rm|rb)\b`,
		String.raw`\bdocker\s+(?:system\s+prune|volume\s+rm|rm\s+-\w*f)`,
		String.raw`\b(?:shutdown|reboot)\b|\bkill(?:all)?\s+-(?:9|KILL)\b|\bpkill\b`,
		String.raw`\bfind\b[^|;&]*\s-delete\b`,
	].join("|"),
	"i",
);

const SENSITIVE = new RegExp(
	[
		String.raw`\bsudo\b`,
		String.raw`\bch(?:mod|own)\b`,
		String.raw`\bgh\s+(?:auth|secret|ssh-key|gpg-key)\b|\bgh\s+repo\s+edit\b[^|;&]*--visibility`,
		String.raw`\/branches\/[^\s/]+\/protection\b`,
		String.raw`\baws\s+(?:iam|sts|kms|secretsmanager|ssm)\b`,
		String.raw`\bsecurity\s+(?:find|add|delete)-\w+-password\b`,
		String.raw`\bssh-(?:keygen|add)\b|\bgpg\b`,
		String.raw`(?:^|[\s/"'=])(?:\.env(?:\.\w+)?|\.ssh\/|\.aws\/credentials|\.netrc|\.npmrc|id_(?:rsa|ed25519))(?=$|[\s"'/])`,
		String.raw`\b(?:printenv|env)\s*(?:$|[|>;&])`,
		String.raw`--no-verify\b|\bspctl\b|\bcsrutil\b|\bxattr\s+-\w*d`,
		String.raw`\bnpm\s+publish\b|\b(?:op|vault)\s+(?:read|item|kv)\b`,
	].join("|"),
	"i",
);

const SETTING = "Settings > Sessions > GSD Mode";

/**
 * Why GSD Mode won't run this by itself, or null when it may. `text` is a
 * command, or the text of a yes/no check the terminal is asking.
 */
export function gsdHeld(text: string, allow: GsdAllow): string | null {
	for (const [pattern, why] of NEVER)
		if (pattern.test(text)) return `${why}, which GSD Mode never does`;
	if (!allow.merge && MERGE.test(text))
		return `it merges, and merging is off in ${SETTING}`;
	if (!allow.destructive && DESTRUCTIVE.test(text))
		return `it deletes or overwrites something, and that is off in ${SETTING}`;
	if (!allow.sensitive && SENSITIVE.test(text))
		return `it touches credentials or permissions, and that is off in ${SETTING}`;
	return null;
}

/** An action item that asks for a merge: not Claude's to decide while merging is off. */
export function isMergeItem(item: string): boolean {
	return /\b(?:merge|land|ship)\b/i.test(item);
}

/** The limits in words, for what Odin tells Claude in GSD Mode. Empty when all are lifted. */
export function gsdLimitsLine(allow: GsdAllow): string {
	const off = [
		!allow.merge && "merge a pull request or push to the default branch",
		!allow.destructive &&
			"delete, overwrite or tear down anything (files, branches, data, cloud resources)",
		!allow.sensitive &&
			"touch credentials, secrets, permissions or protections",
	].filter(Boolean);
	return off.length
		? `GSD Mode's limits, which I set: don't ${off.join("; don't ")}. That holds for your own tools too, not only \`!\` blocks - Odin won't run such a command or approve such a check. Leave each of those as an action item for me and do the rest.`
		: "";
}
