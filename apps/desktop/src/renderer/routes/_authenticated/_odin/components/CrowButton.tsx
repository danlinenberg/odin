import { toast } from "@odin/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@odin/ui/tooltip";
import { useEffect, useRef, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { formatRelativeTime } from "renderer/lib/formatRelativeTime";
import {
	type CrowChat as SavedChat,
	useCrowChats,
} from "renderer/stores/crow-chats";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { Pane } from "renderer/stores/tabs/types";
import { ChatView, interruptClaude } from "../board/ChatView";
import { endSession } from "../hooks/useDone";
import { CrowIcon } from "./CrowIcon";
import { type PromptImage, readFile } from "./OdinPromptDialog";

/** Set once the raven's panel has been opened; until then it asks to be tried. */
// Keeps its old name, so the ring does not come back for anyone who opened it.
const SEEN_KEY = "odin-huginn-seen";
const wasSeen = () => {
	try {
		return localStorage.getItem(SEEN_KEY) === "1";
	} catch {
		return true;
	}
};

/** A rail icon's size, so it sits in the rail like one. */
const SIZE = 36;

const PANEL_W = 300;
/** Wider and taller once there's a conversation to read. */
const CHAT_W = 440;
const CHAT_H = 560;

/** Asks that show what the crow can do in Odin - a click sends one. */
const SUGGESTIONS = [
	"Turn on the Night Agent tonight, 23:00 to 07:00",
	"Start my 3 highest-priority backlog tasks",
	"Which sessions are waiting on me, and why?",
	"What did my sessions ship this week?",
];

/** "dan" from the OS account - Odin has no profile name of its own. */
const firstName = () => {
	const user = window.App?.username ?? "";
	return user && user[0].toUpperCase() + user.slice(1);
};

/**
 * The crow's panel: opens beside the button, Assistant-style - a greeting,
 * a couple of asks to click, and one box. Paste an image to attach it.
 */
function CrowPanel({
	anchor,
	conversation,
	onAsk,
	onResume,
	onClose,
	onShowOnBoard,
}: {
	anchor: { x: number; y: number };
	/** The open conversation - shown right here, with its reply box. */
	conversation?: Pane;
	onAsk: (text: string, files: PromptImage[]) => Promise<boolean>;
	onResume: (chat: SavedChat) => Promise<boolean>;
	onClose: () => void;
	onShowOnBoard: (paneId: string) => void;
}) {
	const [text, setText] = useState("");
	const [files, setFiles] = useState<PromptImage[]>([]);
	const [sending, setSending] = useState(false);
	const panel = useRef<HTMLDivElement>(null);
	const chats = useCrowChats((s) => s.chats);
	const dropChat = useCrowChats((s) => s.drop);

	// Click anywhere else, or Escape, closes it.
	useEffect(() => {
		const onDown = (e: PointerEvent) => {
			const target = e.target as HTMLElement;
			if (!panel.current?.contains(target) && !target.closest("[data-crow]"))
				onClose();
		};
		// Captured, so a focused terminal can't swallow it first, and stopped,
		// so the session drawer under the panel stays open.
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.stopPropagation();
			onClose();
		};
		document.addEventListener("pointerdown", onDown);
		document.addEventListener("keydown", onKey, { capture: true });
		return () => {
			document.removeEventListener("pointerdown", onDown);
			document.removeEventListener("keydown", onKey, { capture: true });
		};
	}, [onClose]);

	const send = async (ask: string) => {
		if (sending || (!ask.trim() && files.length === 0)) return;
		setSending(true);
		if (await onAsk(ask, files)) {
			setText("");
			setFiles([]);
		}
		setSending(false);
	};

	// Beside the button, on whichever side has room. Low on the screen it
	// grows up from the button's bottom; high up, down from its top.
	const width = conversation ? CHAT_W : PANEL_W;
	const right = anchor.x + SIZE / 2 < window.innerWidth / 2;
	const left = right ? anchor.x + SIZE + 10 : anchor.x - width - 10;
	const down = anchor.y + SIZE / 2 < window.innerHeight / 2;
	const vertical = down
		? { top: Math.max(anchor.y, 8) }
		: { bottom: Math.max(window.innerHeight - anchor.y - SIZE, 8) };
	const room = window.innerHeight - (vertical.top ?? vertical.bottom ?? 0) - 8;
	const name = firstName();
	const icon = (
		<span className="relative flex size-6 shrink-0 items-center justify-center">
			<span className="absolute inset-0 rounded-full bg-violet-500/60 blur-md" />
			<CrowIcon className="relative size-5" />
		</span>
	);

	if (conversation)
		return (
			<div
				ref={panel}
				data-crow-panel
				style={{
					left: Math.max(left, 8),
					...vertical,
					width,
					height: Math.min(CHAT_H, room),
				}}
				className="fixed z-[60] flex flex-col overflow-hidden rounded-2xl border border-violet-400/50 bg-tertiary text-popover-foreground shadow-2xl shadow-black/30"
			>
				{/* A row of its own: floated over the chat, scrolled text ran under them. */}
				<div className="flex shrink-0 items-center justify-between px-2.5 pt-2.5">
					{icon}
					<button
						type="button"
						title="Start a fresh conversation - this one stays under Earlier chats"
						onClick={() => endSession(conversation.id)}
						className="rounded-md px-2 py-0.5 text-[11.5px] text-muted-foreground hover:bg-accent hover:text-foreground"
					>
						New chat
					</button>
				</div>
				<CrowChat
					pane={conversation}
					onAsk={onAsk}
					onShowOnBoard={onShowOnBoard}
				/>
			</div>
		);

	return (
		<div
			ref={panel}
			data-crow-panel
			style={{ left: Math.max(left, 8), ...vertical, width, maxHeight: room }}
			className="fixed z-[60] flex flex-col gap-3.5 rounded-xl border border-violet-400/50 bg-tertiary p-4 text-popover-foreground shadow-2xl shadow-black/30"
		>
			<div className="flex items-start gap-2.5 text-[14px] leading-snug">
				{icon}
				<div>
					<div className="font-semibold">Hi{name && ` ${name}`},</div>
					<div className="text-foreground/85">How can I help you today?</div>
				</div>
			</div>
			<div className="flex flex-col gap-2">
				{SUGGESTIONS.map((ask) => (
					<button
						key={ask}
						type="button"
						disabled={sending}
						onClick={() => void send(ask)}
						className="flex items-start gap-2 text-left text-[12.5px] text-link hover:underline"
					>
						<span aria-hidden="true">↳</span>
						{ask}
					</button>
				))}
			</div>
			{chats.length > 0 && (
				<div className="flex min-h-0 flex-col gap-1">
					<div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
						Earlier chats
					</div>
					<div className="-mx-1.5 flex max-h-40 flex-col overflow-y-auto">
						{chats.map((chat) => (
							<div
								key={chat.sessionId}
								className="group flex items-center rounded-md hover:bg-accent"
							>
								<button
									type="button"
									disabled={sending}
									title="Pick up this conversation where it left off"
									onClick={async () => {
										setSending(true);
										try {
											await onResume(chat);
										} catch (error) {
											toast.error(String(error));
										} finally {
											setSending(false);
										}
									}}
									className="flex min-w-0 flex-1 items-baseline gap-2 px-1.5 py-1 text-left text-[12.5px] disabled:opacity-50"
								>
									<span className="min-w-0 flex-1 truncate text-foreground/85">
										{chat.title}
									</span>
									<span className="shrink-0 text-[11px] text-muted-foreground">
										{formatRelativeTime(chat.at)}
									</span>
								</button>
								<button
									type="button"
									aria-label={`Delete "${chat.title}"`}
									title="Delete this chat"
									onClick={() => dropChat(chat.sessionId)}
									className="mr-1 shrink-0 rounded px-1 text-[12px] text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
								>
									✕
								</button>
							</div>
						))}
					</div>
				</div>
			)}
			{files.length > 0 && (
				<div className="flex flex-wrap gap-1.5">
					{files.map((file, index) => (
						<button
							key={`${file.name}-${index}`}
							type="button"
							title="Remove"
							onClick={() => setFiles(files.filter((_, i) => i !== index))}
							className="rounded-full bg-foreground/10 px-2 py-0.5 text-[11px] text-foreground/70 hover:bg-foreground/15"
						>
							{file.name} ✕
						</button>
					))}
				</div>
			)}
			<form
				onSubmit={(e) => {
					e.preventDefault();
					void send(text);
				}}
				className="flex items-center gap-2 rounded-full bg-foreground/10 py-1 pl-3.5 pr-1"
			>
				<input
					// biome-ignore lint/a11y/noAutofocus: the panel only opens on an explicit click, and typing is the next step
					autoFocus
					value={text}
					onChange={(e) => setText(e.target.value)}
					onPaste={async (e) => {
						const pasted = [...e.clipboardData.files].filter((file) =>
							file.type.startsWith("image/"),
						);
						if (pasted.length === 0) return;
						e.preventDefault();
						const read = await Promise.all(pasted.map(readFile));
						setFiles((current) => [...current, ...read]);
					}}
					placeholder="Got a job for me?"
					className="min-w-0 flex-1 bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground"
				/>
				<button
					type="submit"
					aria-label="Send"
					disabled={sending || (!text.trim() && files.length === 0)}
					className="flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground/15 text-foreground transition-colors hover:bg-foreground/25 disabled:opacity-40"
				>
					↑
				</button>
			</form>
		</div>
	);
}

/** The conversation itself - the board drawer's chat view, reply box and all. */
function CrowChat({
	pane,
	onAsk,
	onShowOnBoard,
}: {
	pane: Pane;
	onAsk: (text: string, files: PromptImage[]) => Promise<boolean>;
	onShowOnBoard: (paneId: string) => void;
}) {
	const utils = electronTrpc.useUtils();
	const workspaceId = useTabsStore(
		(s) => s.tabs.find((tab) => tab.id === pane.tabId)?.workspaceId,
	);
	if (!workspaceId) return null;
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<ChatView
				key={pane.id}
				paneId={pane.id}
				sessionId={pane.claudeSessionId ?? null}
				cwd={pane.cwd ?? pane.initialCwd ?? undefined}
				workspaceId={workspaceId}
				working={pane.status === "working"}
				noTerminal
				tldrOnly
				placeholder="What else can I do for you?"
				// Through ask: it resumes a PTY a daemon restart killed, where
				// typing straight in would vanish.
				onSend={(text) => void onAsk(text, [])}
				onShowTerminal={() => onShowOnBoard(pane.id)}
				onOpenSession={onShowOnBoard}
				onStop={async () => {
					// The drawer's Interrupt: Ctrl+C, and out of Working now - Claude
					// fires no Stop hook on an interrupt.
					const sent = await interruptClaude(
						utils.client.terminal.write.mutate,
						utils.client.terminal.readScreen.query,
						pane.id,
					);
					useTabsStore
						.getState()
						.setPaneStatus(pane.id, sent ? "idle" : "review");
				}}
			/>
		</div>
	);
}

/**
 * Odin's raven: the last icon in the rail, under Settings. Opens Odin's own agent
 * in a panel beside it.
 */
export function CrowButton({
	open,
	onOpen,
	onClose,
	onAsk,
	onResume,
	conversation,
	onShowOnBoard,
	keys,
}: {
	open: boolean;
	onOpen: () => void;
	onClose: () => void;
	onAsk: (text: string, files: PromptImage[]) => Promise<boolean>;
	onResume: (chat: SavedChat) => Promise<boolean>;
	conversation?: Pane;
	onShowOnBoard: (paneId: string) => void;
	/** The hotkey, for the tooltip. */
	keys?: string;
}) {
	// Same query and interval as useCrow's, so a cache hit.
	const { data: daemon } = electronTrpc.terminal.listDaemonSessions.useQuery(
		undefined,
		{ refetchInterval: 15_000 },
	);
	// Shown only while its Claude runs. One a restart ended has nothing to
	// type into; the greeting's box asks through useCrow, which resumes it.
	const liveConversation = daemon?.sessions.some(
		(s) => s.sessionId === conversation?.id && s.isAlive,
	)
		? conversation
		: undefined;
	const button = useRef<HTMLButtonElement>(null);
	const status = liveConversation?.status;
	const working = status === "working";
	// An answer, a question, or a failure waiting for you.
	const waiting =
		status === "review" || status === "permission" || status === "failed";
	// Reading it is enough: an answer, a question or a failure, the dot goes.
	useEffect(() => {
		const status = conversation?.status;
		if (
			open &&
			conversation &&
			(status === "review" || status === "permission" || status === "failed")
		)
			useTabsStore.getState().setPaneStatus(conversation.id, "idle");
	}, [open, conversation]);
	const rect = open ? button.current?.getBoundingClientRect() : undefined;
	// Never opened: a pulsing ring, and the tooltip says how to use it.
	const [seen, setSeen] = useState(wasSeen);
	useEffect(() => {
		if (!open || seen) return;
		setSeen(true);
		try {
			localStorage.setItem(SEEN_KEY, "1");
		} catch {}
	}, [open, seen]);

	return (
		<>
			<Tooltip delayDuration={300}>
				<TooltipTrigger asChild>
					<button
						type="button"
						data-crow
						aria-label="Ask the raven"
						ref={button}
						className={`relative z-[60] flex size-9 items-center justify-center rounded-[9px] transition-colors ${open ? "bg-violet-500/20 text-violet-200" : "text-muted-foreground hover:text-foreground"}`}
						onClick={open ? onClose : onOpen}
					>
						<CrowIcon
							className={`size-[19px] drop-shadow-[0_0_5px_rgba(167,139,250,0.6)] ${working ? "animate-[odin-nod_1.6s_ease-in-out_infinite]" : ""} motion-reduce:[&_*]:animate-none motion-reduce:animate-none`}
							idle={!working}
						/>
						{!seen && !open && (
							<span className="pointer-events-none absolute -inset-0.5 rounded-[11px] border-2 border-violet-400 animate-[raven-ring_2.4s_ease-out_infinite] motion-reduce:animate-none" />
						)}
						{(working || waiting) && !open && (
							<span
								className={`absolute right-1 top-1 size-2 rounded-full ring-2 ring-tertiary ${working ? "animate-pulse bg-working" : "bg-attention"}`}
							/>
						)}
					</button>
				</TooltipTrigger>
				{!open && (
					<TooltipContent side="right" align="end" className="max-w-[240px]">
						<div className="font-semibold">
							{!seen && "New: "}Huginn, Odin's raven{keys && ` (${keys})`}
						</div>
						<div className="text-muted-foreground">
							{!seen
								? 'Click me and tell me what to do in Odin, like "Start my top 5 backlog tasks". I answer anything else too.'
								: working
									? "Working on it..."
									: waiting
										? "Has something for you."
										: "Give it instructions for Odin, or ask it anything."}
						</div>
					</TooltipContent>
				)}
			</Tooltip>
			{rect && (
				<CrowPanel
					anchor={{ x: rect.x, y: rect.y }}
					conversation={liveConversation}
					onAsk={onAsk}
					onResume={onResume}
					onClose={onClose}
					onShowOnBoard={onShowOnBoard}
				/>
			)}
		</>
	);
}
