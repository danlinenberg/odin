import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { createTRPCReact } from "@trpc/react-query";
import type { PhoneRouter } from "main/lib/phone/router";
import { useEffect, useRef, useState } from "react";
import ReactDom from "react-dom/client";
import type { PaneStatus } from "shared/tabs-types";
import superjson from "superjson";
import {
	AttachButton,
	appendWords,
	MicButton,
	UploadChips,
	useUploads,
} from "./attach";
import { Markdown } from "./markdown";
import { type Pairing, parsePairLink } from "./pair-link";
import { useSpeech } from "./speech";
import "../globals.css";
import "./mobile.css";

/**
 * The iPhone app's screens (apps/mobile; the Mac side is main/lib/phone): the
 * board as one list, and a session as a chat. Bundled into the app, so it
 * needs the Mac's address: Settings' QR code, odin://pair?u=<link>, saves it.
 */

/** The Capacitor bridge, when this runs inside the iOS app. */
type AppPlugin = {
	addListener: (
		event: "appUrlOpen",
		listener: (data: { url: string }) => void,
	) => unknown;
	getLaunchUrl: () => Promise<{ url?: string } | undefined>;
};
const native = (window as { Capacitor?: { Plugins?: { App?: AppPlugin } } })
	.Capacitor;

const PAIRING_KEY = "odin-phone-pairing";

function savedPairing(): Pairing | null {
	// The token in the page's URL: a browser on `bun run dev`, or the app in
	// live mode (apps/mobile/scripts/sim.sh --live). Talk to that origin.
	const token = new URLSearchParams(location.search).get("t");
	if (token) return { base: location.origin, token };
	if (!native) return null;
	try {
		return JSON.parse(localStorage.getItem(PAIRING_KEY) ?? "null");
	} catch {
		return null;
	}
}

// ponytail: pairing reloads the page, so the client below is built once.
function pairWith(link: string): boolean {
	const pairing = parsePairLink(link);
	if (!pairing) return false;
	localStorage.setItem(PAIRING_KEY, JSON.stringify(pairing));
	location.reload();
	return true;
}

const pairing = savedPairing();
const phone = createTRPCReact<PhoneRouter>();
const client = phone.createClient({
	links: [
		httpBatchLink({
			url: `${pairing?.base ?? ""}/trpc`,
			transformer: superjson,
			headers: { authorization: `Bearer ${pairing?.token ?? ""}` },
		}),
	],
});
const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: 1 } },
});

// No ^ v ✓ bar over the keyboard: one box per screen, nothing to step through.
void (
	window as {
		Capacitor?: {
			nativePromise?: (
				plugin: string,
				method: string,
				options: object,
			) => Promise<unknown>;
		};
	}
).Capacitor?.nativePromise?.("Keyboard", "setAccessoryBarVisible", {
	isVisible: false,
})?.catch(() => {});

if (native?.Plugins?.App) {
	const app = native.Plugins.App;
	app.addListener("appUrlOpen", ({ url }) => pairWith(url));
	void app.getLaunchUrl().then((launch) => {
		const link = launch?.url;
		const next = link && parsePairLink(link);
		// Opened by a pair link: save it unless it's the one already saved.
		if (next && next.token !== pairing?.token) pairWith(link);
	});
}

// ponytail: polling every 3s; a subscription when the board needs to feel instant.
const POLL = 3_000;

const STATUS: Record<PaneStatus, { color: string; label: string }> = {
	permission: { color: "var(--attention)", label: "Needs you" },
	working: { color: "var(--working)", label: "Working" },
	review: { color: "var(--success)", label: "Final Review" },
	idle: { color: "var(--faint-foreground)", label: "Idle" },
	failed: { color: "var(--danger)", label: "Failed" },
};
const ORDER: PaneStatus[] = ["permission", "working", "review", "idle"];

const paneInHash = () => location.hash.match(/^#\/s\/(.+)$/)?.[1] ?? null;

const usePaneFromHash = () => {
	const [paneId, setPaneId] = useState(paneInHash);
	useEffect(() => {
		const onHash = () => setPaneId(paneInHash());
		addEventListener("hashchange", onHash);
		return () => removeEventListener("hashchange", onHash);
	}, []);
	return paneId;
};

function Dot({ status }: { status: PaneStatus }) {
	return (
		<span
			className="inline-block size-2 shrink-0 rounded-full"
			style={{ background: STATUS[status].color }}
		/>
	);
}

/** A plain message as the error line's input. */
const textError = (message: string | null) => (message ? { message } : null);

/** The server answers a missing or old token with a bare 401. */
const unpaired = (error: unknown) =>
	(error as { meta?: { response?: { status?: number } } }).meta?.response
		?.status === 401;

function ErrorLine({ error }: { error: { message: string } | null }) {
	if (!error) return null;
	return (
		<div className="mx-3 my-2 rounded-lg bg-secondary px-3 py-2 text-sm text-danger select-text">
			{unpaired(error) ? (
				<>
					This phone is no longer paired. Scan the QR code in Odin again.
					{native && (
						<button
							type="button"
							onClick={() => {
								localStorage.removeItem(PAIRING_KEY);
								location.reload();
							}}
							className="ml-2 font-semibold text-primary"
						>
							Pair again
						</button>
					)}
				</>
			) : (
				error.message
			)}
		</div>
	);
}

function Home() {
	const board = phone.board.useQuery(undefined, { refetchInterval: POLL });
	const start = phone.start.useMutation({
		onSuccess: () => void board.refetch(),
	});
	const [adding, setAdding] = useState(false);
	const sessions = board.data?.sessions ?? [];
	return (
		<div className="min-h-dvh pb-24">
			<header className="sticky top-0 z-10 border-b border-border bg-background/95 px-4 pt-[calc(env(safe-area-inset-top)+12px)] pb-2 backdrop-blur">
				<h1 className="text-2xl font-bold">Odin</h1>
			</header>
			<ErrorLine error={board.error} />
			{board.isLoading && (
				<div className="px-4 py-6 text-sm text-muted-foreground">Loading…</div>
			)}
			{ORDER.map((column) => {
				const rows = sessions.filter((s) => s.column === column);
				if (rows.length === 0) return null;
				return (
					<section key={column}>
						<h2 className="px-4 pt-4 pb-1 text-[11px] font-semibold uppercase tracking-wide text-faint-foreground">
							{STATUS[column].label} · {rows.length}
						</h2>
						{rows.map((s) => (
							<a
								key={s.paneId}
								href={`#/s/${s.paneId}`}
								className="mx-3 my-1.5 block rounded-[10px] border border-border bg-card px-3 py-2.5 active:bg-accent"
							>
								<div className="flex items-center gap-2 text-[15px] font-semibold">
									<Dot status={column} />
									<span className="truncate">{s.title}</span>
								</div>
								<div className="mt-0.5 truncate pl-4 text-xs text-muted-foreground">
									{[s.repo, s.contact].filter(Boolean).join(" · ") ||
										STATUS[column].label}
								</div>
							</a>
						))}
					</section>
				);
			})}
			{board.data && sessions.length === 0 && (
				<div className="px-4 py-6 text-sm text-muted-foreground">
					Nothing running.
				</div>
			)}
			{!!board.data?.backlog.length && (
				<section>
					<h2 className="px-4 pt-4 pb-1 text-[11px] font-semibold uppercase tracking-wide text-faint-foreground">
						Backlog · {board.data.backlog.length}
					</h2>
					{board.data.backlog.map((task) => (
						<div
							key={task.id}
							className="mx-3 my-1.5 flex items-center gap-3 rounded-[10px] border border-border bg-card px-3 py-2.5"
						>
							<span className="min-w-0 flex-1 truncate text-[15px]">
								{task.title}
							</span>
							<button
								type="button"
								disabled={start.isPending}
								onClick={() => start.mutate({ id: task.id })}
								className="h-9 shrink-0 rounded-full bg-secondary px-4 text-sm font-semibold text-primary"
							>
								Start
							</button>
						</div>
					))}
				</section>
			)}
			<button
				type="button"
				aria-label="New task"
				onClick={() => setAdding(true)}
				className="fixed right-5 size-14 rounded-full bg-primary text-3xl text-primary-foreground shadow-lg"
				style={{ bottom: "calc(env(safe-area-inset-bottom) + 20px)" }}
			>
				+
			</button>
			{adding && (
				<NewTask
					onClose={() => {
						setAdding(false);
						void board.refetch();
					}}
				/>
			)}
		</div>
	);
}

function NewTask({ onClose }: { onClose: () => void }) {
	const [text, setText] = useState("");
	const add = phone.add.useMutation({ onSuccess: onClose });
	const uploads = useUploads(pairing);
	const speech = useSpeech((words) =>
		setText((typed) => appendWords(typed, words)),
	);
	const ready =
		(text.trim() || uploads.paths.length) &&
		!uploads.uploading &&
		!add.isPending;
	return (
		<div className="fixed inset-0 z-10 flex flex-col bg-background/95 p-4 pt-[calc(env(safe-area-inset-top)+12px)]">
			<div className="mb-3 flex items-center justify-between">
				<button type="button" onClick={onClose} className="text-primary">
					Cancel
				</button>
				<span className="font-semibold">New task</span>
				<button
					type="button"
					disabled={!ready}
					onClick={() => add.mutate({ text, paths: uploads.paths })}
					className="font-semibold text-primary disabled:opacity-40"
				>
					Add
				</button>
			</div>
			<textarea
				// biome-ignore lint/a11y/noAutofocus: the sheet exists to type into
				autoFocus
				value={text}
				onChange={(event) => setText(event.target.value)}
				placeholder="What should Claude do? First line is the title."
				className="min-h-48 flex-1 resize-none rounded-[10px] border border-input bg-secondary p-3 text-base outline-none"
			/>
			<UploadChips uploads={uploads} />
			<div className="flex gap-2 pt-2 pb-[env(safe-area-inset-bottom)]">
				<AttachButton uploads={uploads} />
				<MicButton speech={speech} />
			</div>
			<ErrorLine error={add.error ?? textError(speech.error)} />
		</div>
	);
}

/** A reply sent from here that Claude hasn't put in its transcript yet. */
type Sent = { text: string; at: number };

/**
 * Claude writes a message to its transcript when it reads it, so a reply sent
 * while it works stays out of the chat for minutes. These show it until then;
 * kept per session across screens.
 */
const sentByPane = new Map<string, Sent[]>();

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** Drops the replies the transcript shows now - matched on their text. */
function stillWaiting(
	sent: Sent[],
	messages: { role: string; text: string }[],
): Sent[] {
	const said = messages
		.filter((message) => message.role === "user")
		.slice(-20)
		.map((message) => squash(message.text));
	// ponytail: a files-only reply can't be matched on text; it goes after 2 min.
	return sent.filter((item) =>
		item.text.startsWith("📎")
			? Date.now() - item.at < 120_000
			: !said.some((text) => text.includes(squash(item.text).slice(0, 60))),
	);
}

function Session({ paneId }: { paneId: string }) {
	const session = phone.session.useQuery({ paneId }, { refetchInterval: POLL });
	const brief = phone.brief.useQuery({ paneId }, { staleTime: 60_000 });
	const refetch = () => void session.refetch();
	const reply = phone.reply.useMutation({ onSuccess: refetch });
	const [sent, setSent] = useState<Sent[]>(() => sentByPane.get(paneId) ?? []);
	const key = phone.key.useMutation({ onSuccess: refetch });
	const done = phone.done.useMutation({
		onSuccess: () => {
			location.hash = "";
		},
	});
	const [text, setText] = useState("");
	const uploads = useUploads(pairing);
	const speech = useSpeech((words) =>
		setText((typed) => appendWords(typed, words)),
	);
	const ready =
		(text.trim() || uploads.paths.length) &&
		!uploads.uploading &&
		!reply.isPending;
	const bottom = useRef<HTMLDivElement>(null);
	// Follow new messages only while you're at the bottom; reading further up,
	// the ↓ button brings you back.
	const [atBottom, setAtBottom] = useState(true);
	const following = useRef(true);
	const count = session.data?.messages.length ?? 0;
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll when a message lands
	useEffect(() => {
		if (following.current) bottom.current?.scrollIntoView();
	}, [count]);
	const data = session.data;
	const status = (data?.status ?? "idle") as PaneStatus;
	const waiting = stillWaiting(sent, data?.messages ?? []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: forget what the transcript shows now
	useEffect(() => {
		sentByPane.set(paneId, waiting);
		if (waiting.length !== sent.length) setSent(waiting);
	}, [data?.messages]);
	return (
		<div className="relative flex h-dvh flex-col">
			<header className="border-b border-border bg-card px-3.5 pt-[calc(env(safe-area-inset-top)+10px)] pb-2">
				<div className="flex items-center justify-between">
					<a href="#/" className="-ml-1 px-1 py-1.5 text-[15px] text-primary">
						‹ Odin
					</a>
					<button
						type="button"
						disabled={done.isPending}
						onClick={() => done.mutate({ paneId })}
						className="-mr-1 px-1 py-1.5 text-[15px] text-muted-foreground"
					>
						✓ Done
					</button>
				</div>
				<div className="mt-1 truncate text-[17px] font-semibold">
					{data?.title ?? "…"}
				</div>
				<div
					className="text-[11px] font-semibold uppercase"
					style={{ color: STATUS[status].color }}
				>
					● {STATUS[status].label}
				</div>
			</header>
			<main
				className="relative flex-1 overflow-y-auto px-2.5 py-2"
				onScroll={(event) => {
					const el = event.currentTarget;
					const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
					following.current = near;
					setAtBottom(near);
				}}
			>
				<ErrorLine error={session.error ?? done.error} />
				<div className="mb-2 rounded-[10px] border border-border border-l-[3px] border-l-primary bg-card p-2.5 text-sm leading-snug text-soft-foreground">
					<div className="text-[10px] font-semibold text-faint-foreground">
						TL;DR
					</div>
					{brief.isLoading
						? "Writing the TL;DR…"
						: (brief.data ?? "No summary yet.")}
				</div>
				{data?.messages.map((message, index) => (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: the transcript only grows at the end
						key={index}
						className={
							message.role === "user"
								? "my-2 ml-10 select-text whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-accent px-3 py-2 text-[15px] leading-snug"
								: "my-2 mr-6 rounded-2xl rounded-bl-md border border-border bg-card px-3 py-2 text-[15px] leading-snug text-soft-foreground"
						}
					>
						{message.role === "user" ? (
							message.text
						) : (
							<Markdown text={message.text} />
						)}
					</div>
				))}
				{waiting.map((item) => (
					<div
						key={item.at}
						className="my-2 ml-10 select-text whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-accent/60 px-3 py-2 text-[15px] leading-snug"
					>
						{item.text}
						<div className="mt-1 text-right text-[11px] text-muted-foreground">
							Sent · Claude reads it when it's free
						</div>
					</div>
				))}
				{status === "permission" && data?.screen && (
					<pre className="mt-2 overflow-x-auto rounded-[10px] border border-attention/35 bg-attention/10 p-2.5 font-mono text-[11px] leading-snug text-attention-ink">
						{data.screen}
					</pre>
				)}
				<div ref={bottom} />
			</main>
			{!atBottom && (
				<button
					type="button"
					aria-label="Scroll to the latest message"
					onClick={() => bottom.current?.scrollIntoView({ behavior: "smooth" })}
					className="absolute right-4 z-10 flex size-10 items-center justify-center rounded-full border border-border bg-card text-lg shadow-lg"
					style={{ bottom: "calc(env(safe-area-inset-bottom) + 76px)" }}
				>
					↓
				</button>
			)}
			{status === "permission" && (
				<div className="flex gap-2 px-2.5 pt-2">
					{(["1", "2", "3", "enter", "esc"] as const).map((k) => (
						<button
							key={k}
							type="button"
							disabled={key.isPending}
							onClick={() => key.mutate({ paneId, key: k })}
							className={
								k === "1"
									? "h-9 min-w-11 rounded-full bg-primary px-3 text-sm font-semibold text-primary-foreground"
									: "h-9 min-w-11 rounded-full border border-border bg-secondary px-3 text-sm font-semibold"
							}
						>
							{{ enter: "⏎", esc: "Esc" }[k as "enter" | "esc"] ?? k}
						</button>
					))}
				</div>
			)}
			{/* By the box: you tap 🎤 or Send down here, not at the top. */}
			<ErrorLine error={reply.error ?? textError(speech.error)} />
			<UploadChips uploads={uploads} />
			<form
				className="flex items-end gap-2 px-2.5 pt-1.5 pb-[calc(env(safe-area-inset-bottom)+10px)]"
				onSubmit={(event) => {
					event.preventDefault();
					if (!ready) return;
					reply.mutate(
						{ paneId, text, paths: uploads.paths },
						{
							onSuccess: () => {
								const item = {
									text:
										text.trim() ||
										`📎 ${uploads.paths.length} file${uploads.paths.length === 1 ? "" : "s"}`,
									at: Date.now(),
								};
								setSent((all) => [...all, item]);
								sentByPane.set(paneId, [...sent, item]);
								setText("");
								uploads.clear();
								following.current = true;
							},
						},
					);
				}}
			>
				<AttachButton uploads={uploads} />
				<textarea
					rows={1}
					value={text}
					onChange={(event) => setText(event.target.value)}
					placeholder="Reply to Claude…"
					className="max-h-32 min-h-10 flex-1 resize-none rounded-[18px] border border-input bg-secondary px-3 py-2 text-base outline-none"
				/>
				<MicButton speech={speech} />
				<button
					type="submit"
					disabled={!ready}
					className="h-10 rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-40"
				>
					Send
				</button>
			</form>
		</div>
	);
}

function Pair() {
	const [link, setLink] = useState("");
	const [bad, setBad] = useState(false);
	return (
		<div className="flex min-h-dvh flex-col gap-3 p-6 pt-[calc(env(safe-area-inset-top)+24px)]">
			<h1 className="text-2xl font-bold">Pair with Odin</h1>
			<p className="text-sm text-muted-foreground">
				On your Mac, open Odin, Settings, Connections, Phone, and turn on Phone
				access. Scan the "iPhone app" QR code with the Camera, or paste the link
				shown under it.
			</p>
			<form
				className="flex gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					setBad(!pairWith(link));
				}}
			>
				<input
					value={link}
					onChange={(event) => setLink(event.target.value)}
					placeholder="http://your-mac.local:4747/?t=…"
					autoCapitalize="off"
					autoCorrect="off"
					className="min-w-0 flex-1 rounded-[10px] border border-input bg-secondary px-3 py-2 text-base outline-none"
				/>
				<button
					type="submit"
					className="rounded-[10px] bg-primary px-4 font-semibold text-primary-foreground"
				>
					Pair
				</button>
			</form>
			{bad && (
				<div className="text-sm text-danger select-text">
					That isn't an Odin pairing link.
				</div>
			)}
		</div>
	);
}

function App() {
	const paneId = usePaneFromHash();
	if (!pairing)
		return native ? (
			<Pair />
		) : (
			<div className="p-6 text-sm text-muted-foreground">
				Open this from the QR code in Odin: Settings, Connections, Phone.
			</div>
		);
	return paneId ? <Session key={paneId} paneId={paneId} /> : <Home />;
}

// Dev only (apps/mobile/vite.config.ts, remote): run what the dev server
// sends and answer with the result, so the Simulator can be driven headless.
if (import.meta.hot)
	import.meta.hot.on("odin:eval", async ({ id, code }) => {
		let value: unknown;
		try {
			// biome-ignore lint/security/noGlobalEval: dev-only remote control
			value = await globalThis.eval(code);
		} catch (error) {
			value = `Error: ${error}`;
		}
		import.meta.hot?.send("odin:result", {
			id,
			value: JSON.parse(JSON.stringify(value ?? null)),
		});
	});

ReactDom.createRoot(document.getElementById("root") as HTMLElement).render(
	<phone.Provider client={client} queryClient={queryClient}>
		<QueryClientProvider client={queryClient}>
			<App />
		</QueryClientProvider>
	</phone.Provider>,
);
