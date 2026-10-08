import { type ReactNode, useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { type PromptImage, readFile } from "./OdinPromptDialog";

/** Where you dragged the crow; null = its default, low on the left. */
const useCrowPosition = create<{
	pos: { x: number; y: number } | null;
	setPos: (pos: { x: number; y: number }) => void;
}>()(
	persist((set) => ({ pos: null, setPos: (pos) => set({ pos }) }), {
		name: "odin-crow-position",
	}),
);

const SIZE = 40;
/** A press that moves less than this is a click, not a drag. */
const DRAG_PX = 4;

/** Odin's raven, perched: Huginn or Muninn, eye lit. */
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

const PANEL_W = 340;

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
	note,
	onAsk,
	onClose,
}: {
	anchor: { x: number; y: number };
	/** Shown above the box - the open conversation this follows up in. */
	note?: ReactNode;
	onAsk: (text: string, files: PromptImage[]) => Promise<boolean>;
	onClose: () => void;
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
		if (await onAsk(ask, files)) onClose();
		setSending(false);
	};

	// Beside the button, on whichever side has room; bottoms aligned.
	const right = anchor.x + SIZE / 2 < window.innerWidth / 2;
	const left = right ? anchor.x + SIZE + 10 : anchor.x - PANEL_W - 10;
	const bottom = Math.max(window.innerHeight - anchor.y - SIZE, 8);
	const name = firstName();

	return (
		<div
			ref={panel}
			style={{ left: Math.max(left, 8), bottom, width: PANEL_W }}
			className="fixed z-50 flex max-h-[80vh] flex-col gap-5 rounded-2xl border border-white/10 bg-[#1c1c1f] p-6 text-white shadow-2xl shadow-black/50"
		>
			<div className="flex items-center gap-3">
				<span className="relative flex size-8 items-center justify-center">
					<span className="absolute inset-0 rounded-full bg-violet-500/60 blur-md" />
					<CrowIcon className="relative size-7" />
				</span>
				<span className="text-[17px] font-semibold">Crow</span>
			</div>
			<div className="text-[17px] leading-snug">
				<div className="font-semibold">Hi{name && ` ${name}`},</div>
				<div className="text-white/85">How can I help you today?</div>
			</div>
			<div className="flex flex-col gap-3">
				{SUGGESTIONS.map((ask) => (
					<button
						key={ask}
						type="button"
						disabled={sending}
						onClick={() => void send(ask)}
						className="flex items-start gap-3 text-left text-[14px] text-indigo-300 hover:text-indigo-200"
					>
						<span aria-hidden="true">↳</span>
						{ask}
					</button>
				))}
			</div>
			{note && <div className="text-[11.5px] text-white/50">{note}</div>}
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
				className="flex items-center gap-2 rounded-full bg-white/10 py-1.5 pl-4 pr-1.5"
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
					className="min-w-0 flex-1 bg-transparent text-[14px] text-white outline-none placeholder:text-white/45"
				/>
				<button
					type="submit"
					aria-label="Send"
					disabled={sending || (!text.trim() && files.length === 0)}
					className="flex size-7 shrink-0 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25 disabled:opacity-40"
				>
					↑
				</button>
			</form>
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
	note,
	keys,
}: {
	open: boolean;
	onOpen: () => void;
	onClose: () => void;
	onAsk: (text: string, files: PromptImage[]) => Promise<boolean>;
	note?: ReactNode;
	/** The hotkey, for the tooltip. */
	keys?: string;
}) {
	const { pos, setPos } = useCrowPosition();
	const press = useRef<{ x: number; y: number; dx: number; dy: number }>(null);
	/** Set once a press moves - the click that ends a drag doesn't open. */
	const dragged = useRef(false);
	// Clamped, so a smaller window never strands it off-screen.
	const x = Math.min(Math.max(pos?.x ?? 14, 0), window.innerWidth - SIZE);
	const y = Math.min(
		Math.max(pos?.y ?? window.innerHeight - SIZE - 72, 0),
		window.innerHeight - SIZE,
	);

	return (
		<>
			<button
				type="button"
				data-crow
				aria-label="Ask the crow"
				title={`Ask the crow - anything, or tell it what to do in Odin${keys ? ` (${keys})` : ""}. Drag to move.`}
				style={{ left: x, top: y, width: SIZE, height: SIZE }}
				className="fixed z-40 flex touch-none items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-indigo-900 text-white shadow-lg shadow-violet-500/30 ring-1 ring-white/15 transition-transform hover:scale-110 active:cursor-grabbing"
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
				<CrowIcon />
			</button>
			{open && (
				<CrowPanel
					anchor={{ x, y }}
					note={note}
					onAsk={onAsk}
					onClose={onClose}
				/>
			)}
		</>
	);
}
