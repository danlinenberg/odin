import { useEffect, useState } from "react";
import { LuCheck } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useClaudeCommand } from "renderer/stores/claude-command";

/**
 * A strip under the top bar while Claude Code says nobody is signed in on this
 * Mac - the one step between installing Odin and starting a session, for
 * someone who has never opened a terminal. Sign in runs `claude auth login`:
 * the browser opens on claude.ai, you pick your Team account, and the strip
 * goes away.
 *
 * Only an explicit "not signed in" shows it. An API key, Bedrock, an older CLI
 * or your own launch command (Settings → Sessions) all keep it hidden.
 */
export function ClaudeSignInBanner() {
	const customCommand = useClaudeCommand((s) => s.commands.length > 0);
	const { status, login, failed, signedInAs } = useClaudeSignIn(!customCommand);
	const [code, setCode] = useState("");
	const sendCode = electronTrpc.system.claudeLoginCode.useMutation();

	// A successful sign in turns the strip green for a few seconds instead of
	// just vanishing, so you know it worked.
	if (signedInAs !== null)
		return (
			<div className="flex shrink-0 items-center gap-3 bg-success px-4 py-2 text-white">
				<LuCheck className="size-4 shrink-0" />
				<span className="text-sm font-bold">Signed in to Claude</span>
				<span className="min-w-0 select-text truncate text-xs opacity-85">
					{signedInAs
						? `as ${signedInAs}. Sessions are ready to start.`
						: "Sessions are ready to start."}
				</span>
			</div>
		);
	if (customCommand || status.data?.signedIn !== false) return null;

	return (
		<div className="flex shrink-0 items-center gap-3 bg-gradient-to-r from-primary-ink to-primary px-4 py-2 text-primary-foreground shadow-[0_2px_16px_-2px_color-mix(in_oklab,var(--primary)_70%,transparent)]">
			<span className="size-2 shrink-0 animate-pulse rounded-full bg-white" />
			<span className="text-sm font-bold">Sign in to Claude</span>
			<span className="min-w-0 cursor-text select-text truncate text-xs opacity-85">
				{login.isPending
					? "Finish in your browser. If claude.ai shows a code, paste it here."
					: (failed ??
						"Sessions run on your Claude account. Pick your Team plan in the browser.")}
			</span>
			<div className="flex-1" />
			{login.isPending ? (
				<form
					className="flex items-center gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						if (code.trim()) sendCode.mutate({ code });
						setCode("");
					}}
				>
					<input
						value={code}
						onChange={(event) => setCode(event.target.value)}
						placeholder="Paste code"
						className="w-40 rounded-[7px] bg-white/15 px-2 py-1 text-xs placeholder:text-white/60 focus:outline-none"
					/>
					<span className="text-xs opacity-85">Waiting…</span>
				</form>
			) : (
				<button
					type="button"
					onClick={() => login.mutate()}
					className="rounded-[7px] bg-white px-3 py-1 text-xs font-bold text-primary shadow-sm hover:brightness-95"
				>
					{failed ? "Try again" : "Sign in"}
				</button>
			)}
		</div>
	);
}

/**
 * `claude auth login` from anywhere in Odin - the banner and Settings →
 * Connections share it, so a sign in from either updates both. `signedInAs`
 * is the account for a few seconds after a sign in succeeds (empty when
 * Claude doesn't name one), then null again.
 */
export function useClaudeSignIn(enabled = true) {
	const status = electronTrpc.system.claudeAuthStatus.useQuery(undefined, {
		enabled,
		refetchOnWindowFocus: true,
	});
	const [signedInAs, setSignedInAs] = useState<string | null>(null);
	const login = electronTrpc.system.claudeLogin.useMutation({
		onSettled: async (data) => {
			const fresh = await status.refetch();
			if (data?.ok) setSignedInAs(fresh.data?.identity ?? "");
		},
	});
	useEffect(() => {
		if (signedInAs === null) return;
		const timer = setTimeout(() => setSignedInAs(null), 6_000);
		return () => clearTimeout(timer);
	}, [signedInAs]);
	// A thrown error (tRPC) and a failed login (data) both have to show: a
	// silent strip reads as a dead button.
	const failed =
		login.error?.message ??
		(login.data && !login.data.ok ? (login.data.error ?? null) : null);
	return { status, login, failed, signedInAs };
}
