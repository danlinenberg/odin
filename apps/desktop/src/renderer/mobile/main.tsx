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
	LuCamera,
	LuCheck,
	LuChevronDown,
	LuChevronLeft,
	LuCornerDownLeft,
	LuLoaderCircle,
	LuMonitor,
	LuPaperclip,
	LuPlus,
	LuQrCode,
	LuScanQrCode,
	LuStar,
	LuUser,
} from "react-icons/lu";
import { odinScreenStatus } from "shared/odin-screen-status";
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
import { boardSections, DoneShelf, Dot, SessionCard, STATUS } from "./cards";
import { channelFetch, type OdinFetch } from "./odin-fetch";
import { type Pairing, parsePairLink } from "./pair-link";
import { useSpeech } from "./speech";
import { Transcript } from "./transcript";
import "../globals.css";
import "./mobile.css";

/**
 * The iPhone app's screens (apps/mobile; the Mac side is main/lib/phone): the
 * board as one list, and a session as a chat. Bundled into the app, so it
 * needs Odin's key and addresses: Settings' QR code, odin://pair?k=..., saves
 * them, and every call goes through the encrypted channel (odin-fetch.ts).
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

/**
 * Dev only: a token in the page's URL (`bun run dev`, or sim.sh --live) talks
 * plain HTTP to `bun run fake-odin` through the dev server.
 */
const devToken = new URLSearchParams(location.search).get("t");

/** The saved link, read again: a pairing from an older app is no pairing. */
const savedPairing = (): Pairing | null =>
	parsePairLink(localStorage.getItem(PAIRING_KEY) ?? "");

function pairWith(link: string): boolean {
	const pairing = parsePairLink(link);
	if (!pairing) return false;
	localStorage.setItem(PAIRING_KEY, pairing.link);
	location.reload();
	return true;
}

const pairing = devToken ? null : savedPairing();
/** Odin's API: through the channel, or to fake-odin in dev. */
const odinFetch: OdinFetch = pairing
	? channelFetch(pairing)
	: (input, init) =>
			fetch(input, {
				...init,
				headers: { ...init?.headers, authorization: `Bearer ${devToken}` },
			});
const phone = createTRPCReact<PhoneRouter>();
const client = phone.createClient({
	links: [
		httpBatchLink({ url: "/trpc", transformer: superjson, fetch: odinFetch }),
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
		if (next && next.link !== pairing?.link) pairWith(link);
	});
}

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

/**
 * Stars tapped in the last 10 seconds, by session. The window saves a star
 * to main a beat after it sets it, so a poll in between would flip it back;
 * until then the tap wins over what the Mac reports.
 */
const pendingStars = new Map<string, { starred: boolean; at: number }>();
const STAR_HOLD_MS = 10_000;

function holdStar(paneId: string, starred: boolean) {
	pendingStars.set(paneId, { starred, at: Date.now() });
}

function withHeldStars<T extends { paneId: string; starred?: boolean }>(
	sessions: T[],
): T[] {
	const now = Date.now();
	return sessions.map((session) => {
		const held = pendingStars.get(session.paneId);
		if (!held) return session;
		if (now - held.at > STAR_HOLD_MS || held.starred === session.starred) {
			pendingStars.delete(session.paneId);
			return session;
		}
		return { ...session, starred: held.starred };
	});
}

/**
 * Odin's profile, and a switch to another: the iPhone's own picker over a
 * pill. Hidden with one profile. Switching moves the Mac's Odin too, as its
 * profile menu does - one Odin, one profile at a time.
 */
function ProfilePicker() {
	const utils = phone.useUtils();
	const profiles = phone.profiles.useQuery();
	const switchTo = phone.setProfile.useMutation({
		onSuccess: async () => {
			await profiles.refetch();
			// Spinner, not the old profile's board, until the new one lands.
			await utils.board.reset();
		},
	});
	const list = profiles.data?.profiles ?? [];
	if (list.length < 2) return null;
	const activeId = switchTo.variables?.id ?? profiles.data?.activeId;
	const name = list.find((p) => p.id === activeId)?.name ?? "Profile";
	return (
		<label className="relative flex max-w-[55%] items-center gap-1.5 rounded-full bg-secondary px-3 py-1.5 text-sm font-medium">
			{switchTo.isPending ? (
				<LuLoaderCircle className="size-4 shrink-0 animate-spin text-primary" />
			) : (
				<LuUser className="size-4 shrink-0 text-primary" />
			)}
			<span className="truncate">{name}</span>
			<LuChevronDown className="size-4 shrink-0 text-muted-foreground" />
			<select
				aria-label="Profile"
				value={activeId}
				disabled={switchTo.isPending}
				onChange={(event) => switchTo.mutate({ id: event.target.value })}
				className="absolute inset-0 opacity-0"
			>
				{list.map((profile) => (
					<option key={profile.id} value={profile.id}>
						{profile.name}
					</option>
				))}
			</select>
		</label>
	);
}

function Home() {
	const board = phone.board.useQuery(undefined, {
		refetchInterval: POLL,
		select: (data) => ({ ...data, sessions: withHeldStars(data.sessions) }),
	});
	const start = phone.start.useMutation({
		onSuccess: () => void board.refetch(),
	});
	const utils = phone.useUtils();
	// The star moves on tap; the Mac's answer only confirms it (or undoes it).
	const star = phone.star.useMutation({
		onMutate: async ({ paneId, starred }) => {
			holdStar(paneId, starred);
			await utils.board.cancel();
			const before = utils.board.getData();
			utils.board.setData(undefined, (data) =>
				data
					? {
							...data,
							sessions: data.sessions.map((session) =>
								session.paneId === paneId ? { ...session, starred } : session,
							),
						}
					: data,
			);
			return { before };
		},
		onError: (_error, input, context) => {
			pendingStars.delete(input.paneId);
			utils.board.setData(undefined, context?.before);
		},
	});
	const [adding, setAdding] = useState(false);
	const sessions = board.data?.sessions ?? [];
	return (
		<div className="min-h-dvh pb-24">
			<header className="sticky top-0 z-10 border-b border-border bg-background/95 px-4 pt-[calc(env(safe-area-inset-top)+12px)] pb-2 backdrop-blur">
				<div className="flex items-center justify-between gap-3">
					<h1 className="text-2xl font-bold">Board</h1>
					<ProfilePicker />
				</div>
			</header>
			<ErrorLine error={board.error} />
			{board.isLoading && (
				<div className="pointer-events-none fixed inset-0 flex flex-col items-center justify-center gap-4">
					<LuLoaderCircle className="size-14 animate-spin text-primary" />
					<span className="text-sm text-muted-foreground">
						Loading your board
					</span>
				</div>
			)}
			{(board.data ? boardSections(sessions) : []).map((section) => (
				<section key={section.key}>
					<h2 className="px-4 pt-4 pb-1 text-[11px] font-semibold uppercase tracking-wide text-faint-foreground">
						{section.label} · {section.rows.length}
					</h2>
					{section.rows.length === 0 && (
						<div className="mx-3 my-1.5 rounded-[10px] border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
							{section.empty}
						</div>
					)}
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
			<DoneShelf rows={board.data?.done ?? []} />
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
	const uploads = useUploads(odinFetch);
	const speech = useSpeech((words) =>
		setText((typed) => appendWords(typed, words)),
	);
	// Recording counts as text: Save or Start mid-dictation takes the words too.
	const ready =
		(text.trim() || uploads.paths.length || speech.listening) &&
		!uploads.uploading &&
		!speech.transcribing &&
		!add.isPending;
	const save = async (start: boolean) => {
		const words = await speech.finish();
		const full = words ? appendWords(text, words) : text;
		if (!full.trim() && !uploads.paths.length) return;
		add.mutate({
			text: withPriority(full, mark),
			paths: uploads.paths,
			...(repo && { repo }),
			start,
		});
	};
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
					onClick={() => void save(false)}
					className="ml-auto h-10 rounded-full border border-border bg-secondary px-4 text-sm font-semibold disabled:opacity-40"
				>
					Save
				</button>
				<button
					type="button"
					disabled={!ready}
					onClick={() => void save(true)}
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
	return sent.filter((item) =>
		!item.text
			? Date.now() - item.at < 120_000
			: !said.some((text) => text.includes(squash(item.text).slice(0, 60))),
	);
}

function Session({ paneId }: { paneId: string }) {
	const session = phone.session.useQuery({ paneId }, { refetchInterval: POLL });
	const brief = phone.brief.useQuery({ paneId }, { staleTime: 60_000 });
	const [briefOpen, setBriefOpen] = useState(false);
	// Only while the brief is open: every PR is a `gh pr view` on the Mac.
	const links = phone.links.useQuery(
		{ paneId },
		{
			enabled: briefOpen,
			retry: false,
			staleTime: 30_000,
			refetchInterval: briefOpen ? 60_000 : false,
		},
	);
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
	const utils = phone.useUtils();
	// The star moves on tap; the Mac's answer only confirms it (or undoes it).
	const star = phone.star.useMutation({
		onMutate: async ({ starred }) => {
			holdStar(paneId, starred);
			await utils.session.cancel({ paneId });
			const before = utils.session.getData({ paneId });
			utils.session.setData({ paneId }, (data) =>
				data ? { ...data, starred } : data,
			);
			// The board shows it too when you go back.
			utils.board.setData(undefined, (data) =>
				data
					? {
							...data,
							sessions: data.sessions.map((session) =>
								session.paneId === paneId ? { ...session, starred } : session,
							),
						}
					: data,
			);
			return { before };
		},
		onError: (_error, _input, context) => {
			pendingStars.delete(paneId);
			utils.session.setData({ paneId }, context?.before);
			void utils.board.invalidate();
		},
	});
	const done = phone.done.useMutation({
		onSuccess: () => {
			location.hash = "";
		},
	});
	const [text, setText] = useState("");
	const uploads = useUploads(odinFetch);
	const speech = useSpeech((words) =>
		setText((typed) => appendWords(typed, words)),
	);
	// Recording counts as text: Send mid-dictation stops it and sends the words.
	const ready =
		(text.trim() || uploads.paths.length || speech.listening) &&
		!uploads.uploading &&
		!speech.transcribing &&
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
	// Needs you is often a question asked in prose. The screen box and its keys
	// are for a prompt drawn on the screen - a numbered menu, Enter to confirm -
	// read the way the desktop board reads it.
	const asking =
		status === "permission" &&
		!!data?.screen &&
		odinScreenStatus(data.screen) === "permission";
	// An older Odin on the Mac doesn't send it: no star until it does.
	const held = pendingStars.get(paneId);
	const starred =
		held && Date.now() - held.at < STAR_HOLD_MS
			? held.starred
			: !!(data as { starred?: boolean } | undefined)?.starred;
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
					<div className="flex items-center gap-5">
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
				<BriefCard
					brief={brief.data}
					loading={brief.isLoading}
					open={briefOpen}
					onToggle={() => setBriefOpen((shown) => !shown)}
					links={links.data}
					linksLoading={links.isLoading && briefOpen}
				/>
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
				{asking && data?.screen && (
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
			{asking && (
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
				onSubmit={async (event) => {
					event.preventDefault();
					if (!ready) return;
					const words = await speech.finish();
					const full = words ? appendWords(text, words) : text;
					if (!full.trim() && !uploads.paths.length) return;
					reply.mutate(
						{ paneId, text: full, paths: uploads.paths },
						{
							onSuccess: () => {
								remember(full.trim(), uploads.paths.length);
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

const PAIR_STEPS = [
	{
		icon: LuMonitor,
		text: "On your Mac, open Odin, then Settings, Connections, Phone.",
	},
	{ icon: LuQrCode, text: "Turn on Phone access. A QR code appears." },
	{
		icon: LuCamera,
		text: "Open the iPhone Camera and point it at the QR code.",
	},
	{
		icon: LuScanQrCode,
		text: "Tap the Open in Odin banner. The app pairs and shows your board.",
	},
];

function Pair() {
	return (
		<div className="flex min-h-dvh flex-col gap-6 p-6 pt-[calc(env(safe-area-inset-top)+24px)]">
			<h1 className="text-2xl font-bold">Pair with Odin</h1>
			<ol className="flex flex-col gap-4">
				{PAIR_STEPS.map(({ icon: Icon, text }, index) => (
					<li key={text} className="flex items-start gap-3">
						<span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-primary">
							<Icon className="size-[18px]" />
						</span>
						<span className="pt-1.5 text-[15px] leading-snug">
							<span className="font-semibold">{index + 1}.</span> {text}
						</span>
					</li>
				))}
			</ol>
		</div>
	);
}

function App() {
	const paneId = usePaneFromHash();
	if (!pairing && !devToken)
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
