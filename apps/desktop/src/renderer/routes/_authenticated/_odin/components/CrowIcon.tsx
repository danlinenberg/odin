import type { ReactNode } from "react";

/** The raven's wing, drawn from the shoulder. */
const WING =
	"M14.5 9C11 8.6 6.5 10.5 3 13.5l3-.3-1.4 1.6 3.4-.8-1 1.4 3.5-1.2c2.1-.9 3.7-2.6 4-5.2Z";

/**
 * Turns its children about the shoulder: moved to the origin, so a CSS
 * rotate pivots there whatever the SVG's scale.
 */
function Shoulder({
	className,
	children,
}: {
	className: string;
	children: ReactNode;
}) {
	return (
		<g transform="translate(14.5 10)">
			<g
				className={`[transform-box:view-box] [transform-origin:0_0] ${className}`}
			>
				<g transform="translate(-14.5 -10)">{children}</g>
			</g>
		</g>
	);
}

/** Where the feathers leave the wingtip, how big, and when in the beat. */
const FEATHERS = [
	{ x: 4.5, y: 11.3, scale: 1, delay: "0.3s" },
	{ x: 7.5, y: 10.1, scale: 0.8, delay: "0.55s" },
	{ x: 3.4, y: 13.1, scale: 0.7, delay: "0.85s" },
];

/**
 * Huginn, Odin's raven, perched on a branch, eye glowing. Idle, he
 * now and then hops, beats both wings twice and sheds three feathers.
 */
export function CrowIcon({
	className = "size-6",
	idle = false,
}: {
	className?: string;
	/** Now and then he flaps his wings. */
	idle?: boolean;
}) {
	const flap = idle ? "animate-[raven-flap_12s_ease-in-out_infinite]" : "";
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
				<Shoulder className={`${flap} [animation-delay:60ms]`}>
					<path
						fill="currentColor"
						opacity="0.45"
						d={WING}
						transform="rotate(-12 14.5 10)"
					/>
				</Shoulder>
				<path
					fill="currentColor"
					d="M2.5 17.5 7 14.2C6.8 10.2 9.8 7.2 13.6 7c1-1.9 3-2.6 4.8-1.6l3.6 1-3.3 1.2c.6 2.6-.5 5.6-3.5 7.4l-2 .9 1 4.1h-1.4l-1.1-3.8-1.5.2.5 3.6H9.3l-.6-3.5Z"
				/>
				<Shoulder className={flap}>
					<path fill="currentColor" d={WING} />
				</Shoulder>
				<circle
					cx="17.2"
					cy="6.9"
					r="1.4"
					className="fill-amber-300 blur-[0.9px] animate-[raven-eye_3s_ease-in-out_infinite]"
				/>
				<circle cx="17.2" cy="6.9" r="0.85" className="fill-amber-200" />
			</g>
			{idle &&
				FEATHERS.map((feather) => (
					<g
						key={feather.delay}
						transform={`translate(${feather.x} ${feather.y}) scale(${feather.scale})`}
					>
						<path
							fill="currentColor"
							style={{ animationDelay: feather.delay }}
							className="opacity-0 [transform-box:view-box] [transform-origin:0_0] animate-[raven-feather_12s_ease-in_infinite] [animation-fill-mode:both]"
							d="M-1.5 0C-.75-.56.45-.64 1.5 0 .45.64-.75.56-1.5 0Z"
						/>
					</g>
				))}
		</svg>
	);
}
