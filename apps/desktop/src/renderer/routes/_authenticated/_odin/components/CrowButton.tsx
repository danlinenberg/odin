import { useRef } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";

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
function CrowIcon() {
	return (
		<svg viewBox="0 0 24 24" className="size-6" aria-hidden="true">
			<path
				fill="currentColor"
				d="M2.5 17.5 7 14.2C6.8 10.2 9.8 7.2 13.6 7c1-1.9 3-2.6 4.8-1.6l3.6 1-3.3 1.2c.6 2.6-.5 5.6-3.5 7.4l-2 .9 1 4.1h-1.4l-1.1-3.8-1.5.2.5 3.6H9.3l-.6-3.5Z"
			/>
			<circle cx="17.2" cy="6.9" r="0.75" className="fill-amber-300" />
		</svg>
	);
}

/**
 * The crow: a small button floating on the left that opens Odin's own agent.
 * Drag it anywhere; it stays where you put it.
 */
export function CrowButton({
	onOpen,
	keys,
}: {
	onOpen: () => void;
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
		<button
			type="button"
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
				if (!dragged.current) onOpen();
				dragged.current = false;
			}}
		>
			<CrowIcon />
		</button>
	);
}
