import { Button } from "@odin/ui/button";
import { Input } from "@odin/ui/input";
import { toast } from "@odin/ui/sonner";
import { cn } from "@odin/ui/utils";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { FEED_NOTICE_BOX } from "renderer/routes/_authenticated/_odin/components/FeedChrome";
import { resetOdinFeeds } from "renderer/routes/_authenticated/_odin/hooks/useOdinProfile";

/**
 * Sign in to a provider — the one way into every Odin connection.
 *
 * There is no token to paste and no environment variable to set: a shell
 * variable is ambient and would sign every profile into the same account, and
 * a pasted token is the chore OAuth exists to remove. So this button is the
 * whole story, and it lives wherever a missing connection is noticed — the
 * Connections screen and, through `ConnectNotice`, the empty feed itself.
 *
 * Slack, Jira and Notion run the browser consent flow: the token comes
 * back through a deep link into the main process, so this polls for the result
 * rather than awaiting a response. GitHub runs the device flow, which shows a
 * code instead.
 */

export type Provider = "slack" | "jira" | "github" | "notion";

export const PROVIDER_NAME: Record<Provider, string> = {
	slack: "Slack",
	jira: "Jira",
	github: "GitHub",
	notion: "Notion",
};

/** What the consent screen is about to ask for, in one line. */
const SCOPE_BLURB: Record<Provider, string> = {
	slack:
		"Opens Slack in your browser. Read-only: your reactions and the messages behind them.",
	jira: "Opens Atlassian in your browser. Read-only access to issues and users.",
	github: "Opens github.com and asks for a code — scopes: repo, read:org.",
	notion: "Opens Notion in your browser, where you choose what it can see.",
};

export function ConnectProvider({
	provider,
	onConnected,
}: {
	provider: Provider;
	/** Runs after the feeds have been reset, for closing a panel and the like. */
	onConnected?: () => void;
}) {
	const queryClient = useQueryClient();
	const done = () => {
		// The credential changed under every feed, not just this provider's —
		// the same refetch also repaints the Connections rows.
		resetOdinFeeds(queryClient);
		onConnected?.();
	};

	// Remounted per provider, so the branch below never reorders hooks.
	return provider === "github" ? (
		<GithubConnect onDone={done} />
	) : (
		<OAuthConnect provider={provider} onDone={done} />
	);
}

/**
 * A feed's "nothing here because nothing is connected" box: says so, and
 * carries the way out instead of naming a file to go and edit.
 */
export function ConnectNotice({
	provider,
	text,
}: {
	provider: Provider;
	text: string;
}) {
	return (
		<div
			className={cn(
				FEED_NOTICE_BOX,
				"border border-[#25252e] bg-[#111114] text-[#a5a5b3]",
			)}
		>
			<div className="mb-2.5">{text}</div>
			<ConnectProvider provider={provider} />
		</div>
	);
}

function OAuthConnect({
	provider,
	onDone,
}: {
	provider: Exclude<Provider, "github">;
	onDone: () => void;
}) {
	const name = PROVIDER_NAME[provider];
	const configured = electronTrpc.connections.oauthConfigured.useQuery({
		provider,
	});
	const [state, setState] = useState<string | null>(null);

	const start = electronTrpc.connections.oauthStart.useMutation({
		onSuccess: (data) => setState(data.state),
		onError: (error) => toast.error(error.message),
	});
	// Poll only while a consent screen is open. It's a browser round trip, so a
	// second is plenty, and it stops as soon as it resolves.
	const result = electronTrpc.connections.oauthResult.useQuery(
		{ provider, state: state ?? "" },
		{ enabled: state !== null, refetchInterval: 1000 },
	);

	const onDoneRef = useRef(onDone);
	onDoneRef.current = onDone;
	useEffect(() => {
		if (!state || !result.data) return;
		if (result.data.status === "connected") {
			toast.success(`${name} connected`);
			setState(null);
			onDoneRef.current();
		} else if (result.data.status === "failed") {
			toast.error(result.data.error ?? `${name} sign-in failed`);
			setState(null);
		}
	}, [state, result.data, name]);

	if (configured.isLoading) return null;

	// No app, no button: a dead one would fail at the exchange, after someone
	// already approved a consent screen.
	if (!configured.data?.configured) {
		return (
			<p className="text-xs text-muted-foreground">
				This build has no {name} app, so there's nothing to sign in to. See
				docs/oauth/README.md.
			</p>
		);
	}

	if (state) {
		return (
			<div className="space-y-2">
				<p className="text-xs text-muted-foreground">
					Approve Odin in the browser tab that just opened…
				</p>
				<Button variant="ghost" size="sm" onClick={() => setState(null)}>
					Cancel
				</Button>
			</div>
		);
	}

	return (
		<div className="space-y-2">
			<Button
				size="sm"
				disabled={start.isPending}
				onClick={() => start.mutate({ provider })}
			>
				{start.isPending ? `Opening ${name}…` : `Sign in with ${name}`}
			</Button>
			<p className="text-xs text-muted-foreground">{SCOPE_BLURB[provider]}</p>
		</div>
	);
}

/**
 * GitHub's device flow: we show a code, GitHub's page takes it, and we poll
 * until it's approved. No client secret, no redirect URL — the flow GitHub
 * designed for apps like this one.
 */
function GithubConnect({ onDone }: { onDone: () => void }) {
	const clientIdQuery = electronTrpc.connections.githubClientId.useQuery();
	const [clientIdInput, setClientIdInput] = useState("");
	const [code, setCode] = useState<{
		userCode: string;
		verificationUri: string;
		deviceCode: string;
		intervalSeconds: number;
	} | null>(null);
	const openUrl = electronTrpc.external.openUrl.useMutation();

	const saveClientId = electronTrpc.connections.saveGithubClientId.useMutation({
		onSuccess: () => void clientIdQuery.refetch(),
		onError: (error) => toast.error(error.message),
	});
	const start = electronTrpc.connections.githubDeviceStart.useMutation({
		onSuccess: (data) => setCode(data),
		onError: (error) => toast.error(error.message),
	});
	const poll = electronTrpc.connections.githubDevicePoll.useMutation();

	// Poll on the interval GitHub asked for, until it's approved, fails, or the
	// panel closes. The mutation and the callback are held in refs and the effect
	// depends only on `code`: the parent re-renders on every status refetch, and
	// a re-running effect would clear the pending timer each time — polling every
	// few seconds would then never actually fire.
	const pollRef = useRef(poll);
	pollRef.current = poll;
	const onDoneRef = useRef(onDone);
	onDoneRef.current = onDone;
	useEffect(() => {
		if (!code) return;
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout>;
		const tick = async (delaySeconds: number) => {
			timer = setTimeout(async () => {
				if (cancelled) return;
				try {
					const result = await pollRef.current.mutateAsync({
						deviceCode: code.deviceCode,
					});
					if (cancelled) return;
					if (result.state === "connected") {
						toast.success("GitHub connected");
						setCode(null);
						onDoneRef.current();
						return;
					}
					void tick(result.intervalSeconds ?? delaySeconds);
				} catch (error) {
					if (cancelled) return;
					toast.error(error instanceof Error ? error.message : String(error));
					setCode(null);
				}
			}, delaySeconds * 1000);
		};
		void tick(code.intervalSeconds);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [code]);

	if (clientIdQuery.isLoading) return null;

	if (!clientIdQuery.data?.clientId) {
		return (
			<div className="space-y-2">
				<p className="text-xs text-muted-foreground">
					Device login needs a GitHub OAuth app (one-time): create one with
					“Enable Device Flow” checked, then paste its Client ID. No secret
					needed.
				</p>
				<div className="flex gap-2">
					<Input
						value={clientIdInput}
						onChange={(e) => setClientIdInput(e.target.value)}
						placeholder="Ov23li…"
						className="h-8 max-w-72 font-mono text-xs"
					/>
					<Button
						size="sm"
						disabled={!clientIdInput.trim() || saveClientId.isPending}
						onClick={() => saveClientId.mutate({ clientId: clientIdInput })}
					>
						Save
					</Button>
				</div>
				<button
					type="button"
					onClick={() =>
						openUrl.mutate("https://github.com/settings/developers")
					}
					className="text-xs text-muted-foreground underline-offset-2 hover:underline"
				>
					Create an OAuth app ↗ github.com
				</button>
			</div>
		);
	}

	if (code) {
		return (
			<div className="space-y-2">
				<p className="text-xs text-muted-foreground">
					Enter this code on GitHub (the page should already be open):
				</p>
				<div className="select-text cursor-text font-mono text-lg tracking-[.2em]">
					{code.userCode}
				</div>
				<p className="text-xs text-muted-foreground">Waiting for approval…</p>
				<button
					type="button"
					onClick={() => openUrl.mutate(code.verificationUri)}
					className="text-xs text-muted-foreground underline-offset-2 hover:underline"
				>
					Reopen {code.verificationUri} ↗
				</button>
			</div>
		);
	}

	return (
		<div className="space-y-2">
			<Button
				size="sm"
				disabled={start.isPending}
				onClick={() => start.mutate()}
			>
				{start.isPending ? "Starting…" : "Sign in with GitHub"}
			</Button>
			<p className="text-xs text-muted-foreground">{SCOPE_BLURB.github}</p>
		</div>
	);
}
