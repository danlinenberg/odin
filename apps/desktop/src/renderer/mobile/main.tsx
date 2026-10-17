import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { createTRPCReact } from "@trpc/react-query";
import type { PhoneRouter } from "main/lib/phone/router";
import {
	type TextareaHTMLAttributes,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import ReactDom from "react-dom/client";
import {
	LuArrowDown,
	LuCheck,
	LuChevronLeft,
	LuCornerDownLeft,
	LuPaperclip,
	LuPlus,
	LuStar,
} from "react-icons/lu";
import type { PaneStatus } from "shared/tabs-types";
import superjson from "superjson";
import {
	AttachButton,
	appendWords,
	MicButton,
	SpeechStatus,
	UploadChips,
	useUploads,
} from "./attach";
import { BriefCard } from "./brief-card";
import { boardSections, Dot, SessionCard, STATUS } from "./cards";
import { type Pairing, parsePairLink } from "./pair-link";
import { useSpeech } from "./speech";
import { Transcript } from "./transcript";
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
	const star = phone.star.useMutation({
		onSuccess: () => void board.refetch(),
	});
	const [adding, setAdding] = useState(false);
	const sessions = board.data?.sessions ?? [];
	return (
		<div className="min-h-dvh pb-24">
			<header className="sticky top-0 z-10 border-b border-border bg-background/95 px-4 pt-[calc(env(safe-area-inset-top)+12px)] pb-2 backdrop-blur">
				<h1 className="text-2xl font-bold">Board</h1>
			</header>
			<ErrorLine error={board.error} />
			{board.isLoading && (
				<div className="px-4 py-6 text-sm text-muted-foreground">Loading…</div>
			)}
			{boardSections(sessions).map((section) => (
				<section key={section.key}>
					<h2 className="px-4 pt-4 pb-1 text-[11px] font-semibold uppercase tracking-wide text-faint-foreground">
						{section.label} · {section.rows.length}
					</h2>
					{section.rows.map((session) => (
						<SessionCard
							key={session.paneId}
							session={session}
							onStar={(starred) =>
								star.mutate({ paneId: session.paneId, starred })
							}
						/>
					))}
				</section>
			))}
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
				className="fixed right-5 flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg"
				style={{ bottom: "calc(env(safe-area-inset-bottom) + 20px)" }}
			>
				<LuPlus className="size-7" />
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

/** The board's priorities, as the marks the task store reads on the first line. */
const PRIORITIES = [
	{ label: "Low", mark: "!" },
	{ label: "Medium", mark: "" },
	{ label: "High", mark: "!!!" },
] as const;

const withPriority = (text: string, mark: string) =>
	mark ? `${mark} ${text.trimStart()}` : text;

/**
 * New task, as the desktop's: what to do, files, the repo it runs in, its
 * priority, and Save (to the backlog) or Start now.
 */
function NewTask({ onClose }: { onClose: () => void }) {
	const [text, setText] = useState("");
	const [repo, setRepo] = useState("");
	const [mark, setMark] = useState("");
	const add = phone.add.useMutation({ onSuccess: onClose });
	// An older Odin on the Mac has no repo list: the picker just doesn't show.
	const repos = phone.repos.useQuery(undefined, { retry: false });
	const uploads = useUploads(pairing);
	const speech = useSpeech((words) =>
		setText((typed) => appendWords(typed, words)),
	);
	const ready =
		(text.trim() || uploads.paths.length) &&
		!uploads.uploading &&
		!add.isPending;
	const save = (start: boolean) =>
		add.mutate({
			text: withPriority(text, mark),
			paths: uploads.paths,
			...(repo && { repo }),
			start,
		});
	return (
		<div className="fixed inset-0 z-10 flex flex-col gap-2.5 bg-background p-4 pt-[calc(env(safe-area-inset-top)+12px)] pb-[calc(env(safe-area-inset-bottom)+12px)]">
			<div className="flex items-center justify-between">
				<button
					type="button"
					onClick={onClose}
					className="py-1 text-[15px] text-primary"
				>
					Cancel
				</button>
				<span className="font-semibold">New task</span>
				<span className="w-12" />
			</div>
			<textarea
				// biome-ignore lint/a11y/noAutofocus: the sheet exists to type into
				autoFocus
				value={text}
				onChange={(event) => setText(event.target.value)}
				placeholder="What should Odin do? First line is the title."
				className="min-h-40 flex-1 resize-none rounded-[10px] border border-input bg-secondary p-3 text-base outline-none"
			/>
			<SpeechStatus speech={speech} />
			<UploadChips uploads={uploads} />
			{!!repos.data?.length && (
				<select
					value={repo}
					onChange={(event) => setRepo(event.target.value)}
					aria-label="Repo"
					className="h-10 rounded-[10px] border border-input bg-secondary px-3 text-[15px] outline-none"
				>
					<option value="">Default repo</option>
					{repos.data.map((path) => (
						<option key={path} value={path}>
							{path.split("/").filter(Boolean).pop()}
						</option>
					))}
				</select>
			)}
			<fieldset className="flex rounded-[10px] border border-input bg-secondary p-0.5">
				<legend className="sr-only">Priority</legend>
				{PRIORITIES.map((priority) => (
					<button
						key={priority.label}
						type="button"
						aria-pressed={mark === priority.mark}
						onClick={() => setMark(priority.mark)}
						className={`h-9 flex-1 rounded-lg text-sm font-medium ${mark === priority.mark ? "bg-accent text-foreground" : "text-muted-foreground"}`}
					>
						{priority.label}
					</button>
				))}
			</fieldset>
			<ErrorLine error={add.error ?? textError(speech.error)} />
			<div className="flex items-center gap-2">
				<AttachButton uploads={uploads} />
				<MicButton speech={speech} />
				<button
					type="button"
					disabled={!ready}
					onClick={() => save(false)}
					className="ml-auto h-10 rounded-full border border-border bg-secondary px-4 text-sm font-semibold disabled:opacity-40"
				>
					Save
				</button>
				<button
					type="button"
					disabled={!ready}
					onClick={() => save(true)}
					className="h-10 rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-40"
				>
					Start now
				</button>
			</div>
		</div>
	);
}

/**
 * A text box that grows with what's in it - typed or dictated - up to its
 * max-height, then scrolls. Safari has no `field-sizing: content` yet.
 */
function GrowingTextarea(
	props: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string },
) {
	const box = useRef<HTMLTextAreaElement>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: measure when the text changes
	useLayoutEffect(() => {
		const el = box.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight + 2}px`;
	}, [props.value]);
	return <textarea ref={box} rows={1} {...props} />;
}

/** A reply sent from here that Claude hasn't put in its transcript yet. */
type Sent = { text: string; files: number; at: number };

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
		!item.text
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
	/** Shows a reply as Sent until the transcript has it, and follows it down. */
	const remember = (text: string, files: number) => {
		const item = { text, files, at: Date.now() };
		setSent((all) => [...all, item]);
		sentByPane.set(paneId, [...sent, item]);
		following.current = true;
	};
	/** A reply with no files - what an action item's button sends. */
	const sendText = (text: string) =>
		reply.mutate(
			{ paneId, text, paths: [] },
			{ onSuccess: () => remember(text, 0) },
		);
	const key = phone.key.useMutation({ onSuccess: refetch });
	const star = phone.star.useMutation({ onSuccess: refetch });
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
	// An older Odin on the Mac doesn't send it: no star until it does.
	const starred = !!(data as { starred?: boolean } | undefined)?.starred;
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
					<a
						href="#/"
						className="-ml-1.5 flex items-center px-1 py-1.5 text-[15px] text-primary"
					>
						<LuChevronLeft className="size-5" />
						Board
					</a>
					<div className="flex items-center gap-1">
						<button
							type="button"
							aria-label={starred ? "Unstar" : "Star"}
							onClick={() => star.mutate({ paneId, starred: !starred })}
							className={`flex size-9 items-center justify-center ${starred ? "text-attention" : "text-muted-foreground"}`}
						>
							<LuStar
								className={`size-[18px] ${starred ? "fill-current" : ""}`}
							/>
						</button>
						<button
							type="button"
							disabled={done.isPending}
							onClick={() => done.mutate({ paneId })}
							className="-mr-1 flex items-center gap-1 px-1 py-1.5 text-[15px] text-muted-foreground"
						>
							<LuCheck className="size-4" />
							Done
						</button>
					</div>
				</div>
				<div className="mt-1 truncate text-[17px] font-semibold">
					{data?.title ?? "…"}
				</div>
				<div
					className="flex items-center gap-1.5 text-[11px] font-semibold uppercase"
					style={{ color: STATUS[status].color }}
				>
					<Dot status={status} />
					{STATUS[status].label}
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
				<BriefCard brief={brief.data} loading={brief.isLoading} />
				<Transcript
					messages={data?.messages ?? []}
					brief={
						brief.data && typeof brief.data === "object" ? brief.data : null
					}
					send={sendText}
				/>
				{waiting.map((item) => (
					<div
						key={item.at}
						className="my-2 ml-10 select-text whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-accent/60 px-3 py-2 text-[15px] leading-snug"
					>
						{item.text}
						{item.files > 0 && (
							<div className="flex items-center gap-1 text-sm text-soft-foreground">
								<LuPaperclip className="size-3.5" />
								{item.files} file{item.files === 1 ? "" : "s"}
							</div>
						)}
						<div className="mt-1 text-right text-[11px] text-muted-foreground">
							Sent · Odin reads it when it's free
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
					<LuArrowDown className="size-5" />
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
							{k === "enter" ? (
								<LuCornerDownLeft className="mx-auto size-4" />
							) : k === "esc" ? (
								"Esc"
							) : (
								k
							)}
						</button>
					))}
				</div>
			)}
			{/* By the box: you tap 🎤 or Send down here, not at the top. */}
			<ErrorLine error={reply.error ?? textError(speech.error)} />
			<SpeechStatus speech={speech} />
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
								remember(text.trim(), uploads.paths.length);
								setText("");
								uploads.clear();
							},
						},
					);
				}}
			>
				<AttachButton uploads={uploads} />
				<GrowingTextarea
					value={text}
					onChange={(event) => setText(event.target.value)}
					placeholder="Reply to Odin…"
					className="max-h-[40dvh] min-h-10 flex-1 resize-none overflow-y-auto rounded-[18px] border border-input bg-secondary px-3 py-2 text-base outline-none"
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
