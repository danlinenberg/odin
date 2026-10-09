import { Tooltip, TooltipContent, TooltipTrigger } from "@odin/ui/tooltip";
import { useEffect, useRef, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTabsStore } from "renderer/stores/tabs/store";
import type { Pane } from "renderer/stores/tabs/types";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { ChatView } from "../board/ChatView";
import { endSession } from "../hooks/useDone";
import { type PromptImage, readFile } from "./OdinPromptDialog";

/** Where you dragged Hugin; null = its slot at the bottom of the rail. */
const useCrowPosition = create<{
	pos: { x: number; y: number } | null;
	setPos: (pos: { x: number; y: number }) => void;
}>()(
	persist((set) => ({ pos: null, setPos: (pos) => set({ pos }) }), {
		name: "odin-crow-position",
	}),
);

/** A rail icon's size, so it sits in the rail like one. */
const SIZE = 36;
/** The rail's width - the crow's default spot is centred in it. */
const RAIL_W = 52;
/** The rail's bottom padding: Hugin's slot is the last one, under Settings. */
const RAIL_BOTTOM = 10;
/** A press that moves less than this is a click, not a drag. */
const DRAG_PX = 4;

/** Odin's raven, perched: Hugin, eye lit. */
function CrowIcon({ className = "size-6" }: { className?: string }) {
	return (
		<svg viewBox="0 0 24 24" className={className} aria-hidden="true">
			<path
				fill="currentColor"
				d="M2.5 17.5 7 14.2C6.8 10.2 9.8 7.2 13.6 7c1-1.9 3-2.6 4.8-1.6l3.6 1-3.3 1.2c.6 2.6-.5 5.6-3.5 7.4l-2 .9 1 4.1h-1.4l-1.1-3.8-1.5.2.5 3.6H9.3l-.6-3.5Z"
			/>
			<circle cx="17.2" cy="6.9" r="0.75" className="fill-amber-300" />
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

	// Beside the button, on whichever side has room; bottoms aligned.
	const width = conversation ? CHAT_W : PANEL_W;
	const right = anchor.x + SIZE / 2 < window.innerWidth / 2;
	const left = right ? anchor.x + SIZE + 10 : anchor.x - width - 10;
	const bottom = Math.max(window.innerHeight - anchor.y - SIZE, 8);
	const name = firstName();
	const header = (
		<div className="flex items-center gap-3">
			<span className="relative flex size-6 items-center justify-center">
				<span className="absolute inset-0 rounded-full bg-violet-500/60 blur-md" />
				<CrowIcon className="relative size-5" />
			</span>
			<span className="text-[13.5px] font-semibold">Hugin</span>
			{conversation && (
				<span className="ml-auto flex gap-1">
					<button
						type="button"
						title="Open this conversation on the board"
						onClick={() => onShowOnBoard(conversation.id)}
						className="rounded-md px-2 py-1 text-[11.5px] text-white/60 hover:bg-white/10 hover:text-white"
					>
						Open on the board
					</button>
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
					bottom,
					width,
					height: Math.min(CHAT_H, window.innerHeight - bottom - 8),
				}}
				className="fixed z-50 flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#1c1c1f] text-white shadow-2xl shadow-black/50"
			>
				<div className="border-b border-white/10 px-4 py-2.5">{header}</div>
				<CrowChat pane={conversation} onShowOnBoard={onShowOnBoard} />
			</div>
		);

	return (
		<div
			ref={panel}
			style={{ left: Math.max(left, 8), bottom, width }}
			className="fixed z-50 flex max-h-[80vh] flex-col gap-3.5 rounded-xl border border-white/10 bg-[#1c1c1f] p-4 text-white shadow-2xl shadow-black/50"
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
				onShowTerminal={() => onShowOnBoard(pane.id)}
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
 * The crow: a small button floating on the left that opens Odin's own agent
 * in a panel beside it.
 * Drag it anywhere; it stays where you put it.
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
	const { pos, setPos } = useCrowPosition();
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
	const press = useRef<{ x: number; y: number; dx: number; dy: number }>(null);
	/** Set once a press moves - the click that ends a drag doesn't open. */
	const dragged = useRef(false);
	// Clamped, so a smaller window never strands it off-screen.
	// Dropped back on the rail, it docks in its slot again.
	const docked = !pos || pos.x < RAIL_W - SIZE / 2;
	const x = docked
		? (RAIL_W - SIZE) / 2
		: Math.min(Math.max(pos.x, 0), window.innerWidth - SIZE);
	const y = docked
		? window.innerHeight - SIZE - RAIL_BOTTOM
		: Math.min(Math.max(pos.y, 0), window.innerHeight - SIZE);

	return (
		<>
			<Tooltip delayDuration={300}>
				<TooltipTrigger asChild>
					<button
						type="button"
						data-crow
						aria-label="Ask Hugin"
						style={{ left: x, top: y, width: SIZE, height: SIZE }}
						className={`fixed z-40 flex touch-none items-center justify-center rounded-[9px] transition-colors active:cursor-grabbing ${open ? "bg-violet-500/20 text-violet-200" : "text-muted-foreground hover:text-foreground"}`}
						onPointerDown={(e) => {
							e.currentTarget.setPointerCapture(e.pointerId);
							dragged.current = false;
							press.current = {
								x: e.clientX,
								y: e.clientY,
								dx: e.clientX - x,
								dy: e.clientY - y,
							};
						}}
						onPointerMove={(e) => {
							const start = press.current;
							if (!start) return;
							const moved =
								Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y);
							if (!dragged.current && moved < DRAG_PX) return;
							dragged.current = true;
							setPos({ x: e.clientX - start.dx, y: e.clientY - start.dy });
						}}
						onPointerUp={() => {
							press.current = null;
						}}
						onClick={() => {
							if (!dragged.current) (open ? onClose : onOpen)();
							dragged.current = false;
						}}
					>
						<CrowIcon className="size-[19px] drop-shadow-[0_0_5px_rgba(167,139,250,0.6)]" />
					</button>
				</TooltipTrigger>
				{!open && (
					<TooltipContent side="right" className="max-w-[240px]">
						<div className="font-semibold">
							Hugin, Odin's raven{keys && ` (${keys})`}
						</div>
						<div className="text-muted-foreground">
							Give it instructions for Odin, or ask it anything. Drag to move.
						</div>
					</TooltipContent>
				)}
			</Tooltip>
			{open && (
				<CrowPanel
					anchor={{ x, y }}
					conversation={liveConversation}
					onAsk={onAsk}
					onClose={onClose}
					onShowOnBoard={onShowOnBoard}
				/>
			)}
		</>
	);
}
