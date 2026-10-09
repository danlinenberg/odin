import { Tooltip, TooltipContent, TooltipTrigger } from "@odin/ui/tooltip";
import { useEffect, useRef, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { Pane } from "renderer/stores/tabs/types";
import { ChatView } from "../board/ChatView";
import { endSession } from "../hooks/useDone";
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

/** Odin's raven, perched on a branch, eye glowing. He has no name. */
function CrowIcon({
	className = "size-6",
	idle = false,
}: {
	className?: string;
	/** Now and then he flaps his wings. */
	idle?: boolean;
}) {
	return (
		<svg viewBox="0 0 24 24" className={className} aria-hidden="true">
			<path
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
				strokeLinecap="round"
				opacity="0.7"
				d="M3 20.6h18M17.5 20.6l2.6-2.4"
			/>
			<g
				className={idle ? "animate-[raven-lift_12s_ease-in-out_infinite]" : ""}
			>
				<path
					fill="currentColor"
					d="M2.5 17.5 7 14.2C6.8 10.2 9.8 7.2 13.6 7c1-1.9 3-2.6 4.8-1.6l3.6 1-3.3 1.2c.6 2.6-.5 5.6-3.5 7.4l-2 .9 1 4.1h-1.4l-1.1-3.8-1.5.2.5 3.6H9.3l-.6-3.5Z"
				/>
				<path
					fill="currentColor"
					d="M14.5 9C11 8.6 6.5 10.5 3 13.5l3-.3-1.4 1.6 3.4-.8-1 1.4 3.5-1.2c2.1-.9 3.7-2.6 4-5.2Z"
					className={`[transform-origin:14.5px_10px] ${idle ? "animate-[raven-flap_12s_ease-in-out_infinite]" : ""}`}
				/>
				<circle
					cx="17.2"
					cy="6.9"
					r="1.4"
					className="fill-amber-300 blur-[0.9px] animate-[raven-eye_3s_ease-in-out_infinite]"
				/>
				<circle cx="17.2" cy="6.9" r="0.85" className="fill-amber-200" />
			</g>
		</svg>
	);
}

const PANEL_W = 300;
/** Wider and taller once there's a conversation to read. */
const CHAT_W = 440;
const CHAT_H = 560;

/** Asks that show what the crow can do in Odin - a click sends one. */
const SUGGESTIONS = [
	"Start my top 5 backlog tasks",
	"What's waiting on me on the board?",
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
	onClose,
	onShowOnBoard,
}: {
	anchor: { x: number; y: number };
	/** The open conversation - shown right here, with its reply box. */
	conversation?: Pane;
	onAsk: (text: string, files: PromptImage[]) => Promise<boolean>;
	onClose: () => void;
	onShowOnBoard: (paneId: string) => void;
}) {
	const [text, setText] = useState("");
	const [files, setFiles] = useState<PromptImage[]>([]);
	const [sending, setSending] = useState(false);
	const panel = useRef<HTMLDivElement>(null);

	// Click anywhere else, or Escape, closes it.
	useEffect(() => {
		const onDown = (e: PointerEvent) => {
			const target = e.target as HTMLElement;
			if (!panel.current?.contains(target) && !target.closest("[data-crow]"))
				onClose();
		};
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
		document.addEventListener("pointerdown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onDown);
			document.removeEventListener("keydown", onKey);
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
	const header = (
		<div className="flex items-center gap-3">
			<span className="relative flex size-6 items-center justify-center">
				<span className="absolute inset-0 rounded-full bg-violet-500/60 blur-md" />
				<CrowIcon className="relative size-5" />
			</span>
			<span className="text-[13.5px] font-semibold">Odin's raven</span>
			{conversation && (
				<span className="ml-auto flex gap-1">
					<button
						type="button"
						title="End this conversation and start a fresh one"
						onClick={() => endSession(conversation.id)}
						className="rounded-md px-2 py-1 text-[11.5px] text-white/60 hover:bg-white/10 hover:text-white"
					>
						New chat
					</button>
				</span>
			)}
		</div>
	);

	if (conversation)
		return (
			<div
				ref={panel}
				style={{
					left: Math.max(left, 8),
					...vertical,
					width,
					height: Math.min(CHAT_H, room),
				}}
				className="fixed z-[60] flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#1c1c1f] text-white shadow-2xl shadow-black/50"
			>
				<div className="border-b border-white/10 px-4 py-2.5">{header}</div>
				<CrowChat pane={conversation} onShowOnBoard={onShowOnBoard} />
			</div>
		);

	return (
		<div
			ref={panel}
			style={{ left: Math.max(left, 8), ...vertical, width, maxHeight: room }}
			className="fixed z-[60] flex flex-col gap-3.5 rounded-xl border border-white/10 bg-[#1c1c1f] p-4 text-white shadow-2xl shadow-black/50"
		>
			{header}
			<div className="text-[14px] leading-snug">
				<div className="font-semibold">Hi{name && ` ${name}`},</div>
				<div className="text-white/85">How can I help you today?</div>
			</div>
			<div className="flex flex-col gap-2">
				{SUGGESTIONS.map((ask) => (
					<button
						key={ask}
						type="button"
						disabled={sending}
						onClick={() => void send(ask)}
						className="flex items-start gap-2 text-left text-[12.5px] text-indigo-300 hover:text-indigo-200"
					>
						<span aria-hidden="true">↳</span>
						{ask}
					</button>
				))}
			</div>
			{files.length > 0 && (
				<div className="flex flex-wrap gap-1.5">
					{files.map((file, index) => (
						<button
							key={`${file.name}-${index}`}
							type="button"
							title="Remove"
							onClick={() => setFiles(files.filter((_, i) => i !== index))}
							className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-white/70 hover:bg-white/15"
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
				className="flex items-center gap-2 rounded-full bg-white/10 py-1 pl-3.5 pr-1"
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
					className="min-w-0 flex-1 bg-transparent text-[12.5px] text-white outline-none placeholder:text-white/45"
				/>
				<button
					type="submit"
					aria-label="Send"
					disabled={sending || (!text.trim() && files.length === 0)}
					className="flex size-6 shrink-0 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25 disabled:opacity-40"
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
	onShowOnBoard,
}: {
	pane: Pane;
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
				placeholder="What else can I do for you?"
				onShowTerminal={() => onShowOnBoard(pane.id)}
				onOpenSession={onShowOnBoard}
				onStop={() => {
					// The drawer's Interrupt: Ctrl+C, and out of Working now - Claude
					// fires no Stop hook on an interrupt.
					void utils.client.terminal.write.mutate({
						paneId: pane.id,
						data: "\x03",
					});
					useTabsStore.getState().setPaneStatus(pane.id, "idle");
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
	conversation,
	onShowOnBoard,
	keys,
}: {
	open: boolean;
	onOpen: () => void;
	onClose: () => void;
	onAsk: (text: string, files: PromptImage[]) => Promise<boolean>;
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
	// Reading the answer is enough: a question still waits for its reply.
	useEffect(() => {
		if (open && conversation && conversation.status === "review")
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
					onClose={onClose}
					onShowOnBoard={onShowOnBoard}
				/>
			)}
		</>
	);
}
