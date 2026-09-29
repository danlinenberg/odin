/**
 * Mail a machine sent — alerts, receipts, newsletters, "your project is
 * ready". Judged by the sender's address alone: people write from
 * `first.l@`, mailers from `noreply@`, `info@`, `team@mail.vendor.com`.
 *
 * ponytail: a sender rule, not a model — instant, free and predictable, and
 * it sorts a real inbox cleanly. A human who mails from `info@` reads as
 * junk; "Show junk" is the escape hatch. Upgrade: `claude -p` over subjects.
 */
const MACHINE_WORD =
	/no-?reply|donotreply|do-not-reply|notif|notify|automation|alert|mailer|newsletter|announce|digest|marketing|bot\b|-bot|bounce/;
const MACHINE_BOX =
	/^(info|support|team|hello|hi|news|updates?|billing|events?|contact|admin|accounts?|service|help|feedback|sales|security|calendar|invoices?|receipts?|welcome)$/;
/** Bulk-mail subdomains — `mail.airtable.com`, `md.getsentry.com`. */
const MAILER_DOMAIN = /^(mail|email|e|em|md|mg|news|mkt|send|bounce)\d*\./;

export function isJunkEmail(email: { fromEmail?: string | null }): boolean {
	const address = (email.fromEmail ?? "").toLowerCase();
	const [local = "", domain = ""] = address.split("@");
	if (!local) return false;
	const box = local.split("+")[0];
	return (
		MACHINE_WORD.test(box) ||
		MACHINE_BOX.test(box) ||
		MAILER_DOMAIN.test(domain)
	);
}
