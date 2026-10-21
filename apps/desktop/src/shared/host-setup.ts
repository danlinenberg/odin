/**
 * Settings > Remote > Remote host: what every host gets at setup beyond what
 * sessions need - one IAM policy on its role and OS packages, both put on
 * by Use. It is what lets a plugin on the host work out of the box: the
 * policy grants the host what the plugin reads, the packages are the tools
 * it and its skills run. Odin knows a policy ARN and package names, nothing
 * about what they are for. Checked here by Settings before saving, by the
 * router before storing, and by setup before anything runs as root.
 */

/** An IAM policy ARN: one of AWS's managed policies, or one of the account's own. */
const POLICY_ARN = /^arn:aws:iam::(\d{12}|aws):policy\/[\w+=,.@/-]+$/;

/** A name a system package manager takes: letters, digits, . + - _, and never an option. */
const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/** The most an EC2 Name tag gets here; AWS allows 256, the picker's rows do not. */
const HOST_NAME_MAX = 64;

/** Why `text` is not an IAM policy ARN, or null. Empty means no policy. */
export function hostPolicyArnProblem(text: string): string | null {
	const arn = text.trim();
	if (!arn || POLICY_ARN.test(arn)) return null;
	return "Not an IAM policy ARN: arn:aws:iam::<account id>:policy/<name>.";
}

/** Why `text` is not a space-separated list of package names, or null. Empty means none. */
export function hostPackagesProblem(text: string): string | null {
	const bad = text
		.split(/\s+/)
		.find((name) => name && !PACKAGE_NAME.test(name));
	return bad === undefined
		? null
		: `Not a package name: ${bad}. Letters, digits and . + - _ only, separated by spaces.`;
}

/** The names in `text`, once each, in order; throws on one no package manager takes. */
export function packageNames(text: string): string[] {
	const problem = hostPackagesProblem(text);
	if (problem) throw new Error(problem);
	return [...new Set(text.split(/\s+/).filter(Boolean))];
}

/** Why `text` is not a name for a new host (its Name tag), or null. */
export function hostNameProblem(text: string): string | null {
	const name = text.trim();
	if (!name) return "Give the host a name.";
	if (name.length > HOST_NAME_MAX)
		return `A host name is at most ${HOST_NAME_MAX} characters.`;
	if (/\p{Cc}/u.test(name)) return "A host name has no control characters.";
	return null;
}
