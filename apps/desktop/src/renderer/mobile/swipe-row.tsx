import { type ReactNode, useRef, useState } from "react";

/** How far a finger moves before a swipe counts, so a scroll or a tap stays one. */
const SLOP = 8;

/**
 * A row you swipe sideways to show its actions, as in Mail: `left` sits under
 * its left edge (swipe right), `right` under its right edge (swipe left). It
 * stays open past half the actions' width and springs shut otherwise; a tap
 * on an open row, or on an action, closes it. Vertical drags stay the page's
 * scroll (touch-action: pan-y).
 */
export function SwipeRow({
	left,
	right,
	children,
	className = "",
}: {
	/** The actions under each edge; `close` shuts the row after one runs. */
	left?: (close: () => void) => ReactNode;
	right?: (close: () => void) => ReactNode;
	children: ReactNode;
	className?: string;
}) {
	const [x, setX] = useState(0);
	const close = () => setX(0);
	const [dragging, setDragging] = useState(false);
	// Shut, the actions hide: their color showed at the card's round corners.
	const shut = x === 0 && !dragging;
	const leftRef = useRef<HTMLDivElement>(null);
	const rightRef = useRef<HTMLDivElement>(null);
	const drag = useRef<{
		x0: number;
		y0: number;
		base: number;
		sideways: boolean | null;
	} | null>(null);
	// A swipe ends with a click on the row: it must not open the session.
	const swiped = useRef(false);
	const widths = () => ({
		left: leftRef.current?.offsetWidth ?? 0,
		right: rightRef.current?.offsetWidth ?? 0,
	});
	return (
		<div className={`relative overflow-hidden ${className}`}>
			{left && (
				<div
					ref={leftRef}
					className={`absolute inset-y-0 left-0 flex ${shut ? "invisible" : ""}`}
				>
					{left(close)}
				</div>
			)}
			{right && (
				<div
					ref={rightRef}
					className={`absolute inset-y-0 right-0 flex ${shut ? "invisible" : ""}`}
				>
					{right(close)}
				</div>
			)}
			<div
				style={{
					transform: `translateX(${x}px)`,
					transition: dragging ? "none" : "transform 200ms ease-out",
					touchAction: "pan-y",
				}}
				className="relative"
				onPointerDown={(event) => {
					drag.current = {
						x0: event.clientX,
						y0: event.clientY,
						base: x,
						sideways: null,
					};
					swiped.current = false;
				}}
				onPointerMove={(event) => {
					const d = drag.current;
					if (!d) return;
					const dx = event.clientX - d.x0;
					const dy = event.clientY - d.y0;
					if (
						d.sideways === null &&
						Math.max(Math.abs(dx), Math.abs(dy)) > SLOP
					) {
						d.sideways = Math.abs(dx) > Math.abs(dy);
						if (d.sideways) {
							event.currentTarget.setPointerCapture(event.pointerId);
							setDragging(true);
						}
					}
					if (!d.sideways) return;
					swiped.current = true;
					const { left: l, right: r } = widths();
					setX(Math.min(l, Math.max(-r, d.base + dx)));
				}}
				onPointerUp={() => {
					const d = drag.current;
					drag.current = null;
					setDragging(false);
					if (!d?.sideways) return;
					const { left: l, right: r } = widths();
					setX((now) => (now > l / 2 ? l : now < -r / 2 ? -r : 0));
				}}
				onPointerCancel={() => {
					drag.current = null;
					setDragging(false);
					setX(0);
				}}
				onClickCapture={(event) => {
					if (swiped.current || x !== 0) {
						event.preventDefault();
						event.stopPropagation();
						if (!swiped.current) setX(0);
					}
					swiped.current = false;
				}}
			>
				{children}
			</div>
		</div>
	);
}

/** One action under a swiped row: an icon over its name, on its color. */
export function SwipeAction({
	label,
	icon,
	className,
	onClick,
}: {
	label: string;
	icon: ReactNode;
	className: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={`flex w-[76px] flex-col items-center justify-center gap-1 text-[12px] font-semibold ${className}`}
		>
			{icon}
			{label}
		</button>
	);
}
