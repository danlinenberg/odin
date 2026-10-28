import { Input } from "@odin/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@odin/ui/popover";
import { toast } from "@odin/ui/sonner";
import type { WebviewTag } from "electron";
import { useState } from "react";
import { HiKey } from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";

/**
 * Fills the step of a sign-in the page is on: username and password, a
 * one-time code, or just the email of an email-first form. Values go in
 * through the native setter and an input event, so a framework-controlled
 * field (React) keeps them. Says which step it filled, or null.
 */
export const fillLoginScript = ({
	username,
	password,
	otp,
}: {
	username: string;
	password: string;
	otp?: string;
}) => `(() => {
	const visible = (el) => !el.disabled && !el.readOnly && el.getClientRects().length > 0;
	const inputs = [...document.querySelectorAll("input")].filter(visible);
	const set = (el, value) => {
		el.focus();
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, value);
		el.dispatchEvent(new Event("input", { bubbles: true }));
		el.dispatchEvent(new Event("change", { bubbles: true }));
	};
	const isUser = (el) => ["", "text", "email"].includes(el.type);
	const password = inputs.find((el) => el.type === "password");
	if (password) {
		const user = inputs.filter((el) =>
			isUser(el) && el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING,
		).at(-1);
		if (user && ${JSON.stringify(username)}) set(user, ${JSON.stringify(username)});
		set(password, ${JSON.stringify(password)});
		return "login";
	}
	const otp = ${JSON.stringify(otp ?? "")};
	const code = inputs.find((el) =>
		el.autocomplete === "one-time-code" ||
		/otp|totp|2fa|mfa|one.?time|verification|auth.?code|token/i.test(el.name + " " + el.id),
	);
	if (otp && code) {
		set(code, otp);
		return "otp";
	}
	const user = inputs.find((el) =>
		el.type === "email" || /user|email|login/i.test(el.name + " " + el.id + " " + el.autocomplete),
	) ?? inputs.find(isUser);
	if (user && ${JSON.stringify(username)}) {
		set(user, ${JSON.stringify(username)});
		return "username";
	}
	return null;
})()`;

interface Match {
	account: string;
	vaultId: string;
	id: string;
	title: string;
}

/**
 * The in-app browser's key button: fills the page's sign-in from the 1Password
 * app you already have. One login fills straight away; several open a list.
 * The first time, it asks which 1Password account to use.
 */
export function OnePasswordButton({
	className,
	webview,
}: {
	className: string;
	webview: () => WebviewTag | undefined;
}) {
	const [open, setOpen] = useState(false);
	const [matches, setMatches] = useState<Match[]>([]);
	const [setup, setSetup] = useState<string | null>(null);
	const [accountName, setAccountName] = useState("");
	const accounts = electronTrpc.browser.onePasswordAccounts.useQuery();
	const findLogins = electronTrpc.browser.onePasswordLogins.useMutation();
	const getLogin = electronTrpc.browser.onePasswordLogin.useMutation();
	const saveAccounts =
		electronTrpc.browser.setOnePasswordAccounts.useMutation();

	const fill = (match: Match) => {
		const view = webview();
		if (!view) return;
		setOpen(false);
		getLogin.mutate(match, {
			onSuccess: async (login) => {
				if (!login) {
					toast(`"${match.title}" has no password in 1Password`);
					return;
				}
				const filled = await view.executeJavaScript(fillLoginScript(login));
				if (!filled) toast("No sign-in field on this page");
			},
			onError: (error) => toast(error.message),
		});
	};

	const lookUp = () => {
		const view = webview();
		if (!view) return;
		// 1Password can take a while: the first lookup waits for you to unlock
		// it and approve Odin, so say so instead of a silent, disabled button.
		const waiting = setTimeout(
			() =>
				toast.loading("Waiting for 1Password - unlock it and approve Odin", {
					id: "one-password-wait",
				}),
			1500,
		);
		findLogins.mutate(
			{ url: view.getURL() },
			{
				onSettled: () => {
					clearTimeout(waiting);
					toast.dismiss("one-password-wait");
				},
				onSuccess: (result) => {
					if (!result.matches) {
						setSetup(result.message ?? "");
						setAccountName(accounts.data?.[0] ?? "");
						setMatches([]);
						setOpen(true);
						return;
					}
					setSetup(null);
					if (result.matches.length === 0) {
						toast("No 1Password login for this site");
						return;
					}
					const [only] = result.matches;
					if (result.matches.length === 1 && only) {
						fill(only);
						return;
					}
					setMatches(result.matches);
					setOpen(true);
				},
				onError: (error) => toast(error.message),
			},
		);
	};

	const saveAccount = () => {
		saveAccounts.mutate(
			{ accounts: accountName.split(",") },
			{
				onSuccess: () => {
					void accounts.refetch();
					setOpen(false);
					lookUp();
				},
			},
		);
	};

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<button
					type="button"
					title="Fill login from 1Password"
					className={className}
					disabled={findLogins.isPending}
					onClick={(event) => {
						event.preventDefault();
						lookUp();
					}}
				>
					<HiKey className="size-4" />
				</button>
			</PopoverTrigger>
			<PopoverContent align="start" className="z-[70] w-72 p-2">
				{setup !== null ? (
					<form
						className="flex flex-col gap-2 p-1 text-xs"
						onSubmit={(event) => {
							event.preventDefault();
							saveAccount();
						}}
					>
						<p className="select-text cursor-text text-muted-foreground">
							{setup}
						</p>
						<label
							htmlFor="one-password-account"
							className="flex flex-col gap-1"
						>
							Account name, as at the top of 1Password's sidebar (a comma
							between several)
							<Input
								id="one-password-account"
								autoFocus
								value={accountName}
								placeholder="e.g. Imagen"
								onChange={(event) => setAccountName(event.target.value)}
							/>
						</label>
						<button
							type="submit"
							disabled={!accountName.trim()}
							className="self-end rounded-md bg-primary px-2.5 py-1 text-primary-foreground disabled:opacity-50"
						>
							Use this account
						</button>
					</form>
				) : (
					<div className="flex flex-col">
						{matches.map((match) => (
							<button
								key={`${match.account}/${match.id}`}
								type="button"
								className="flex flex-col items-start rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent"
								onClick={() => fill(match)}
							>
								<span className="text-foreground">{match.title}</span>
								<span className="text-muted-foreground">{match.account}</span>
							</button>
						))}
					</div>
				)}
			</PopoverContent>
		</Popover>
	);
}
