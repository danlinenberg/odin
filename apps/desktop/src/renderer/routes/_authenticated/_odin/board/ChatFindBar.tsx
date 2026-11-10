import { type RefObject, useEffect, useRef, useState } from "react";
import { LuChevronDown, LuChevronUp, LuX } from "react-icons/lu";
import { isHotkey, useHotkeyDisplay } from "renderer/hotkeys";
import { findRanges, firstFrom } from "./chat-find";

// Styled in globals.css.
const MATCHES = "chat-search-matches";
const ACTIVE = "chat-search-active";

function paint(ranges: Range[], active: number) {
	if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
	if (ranges.length === 0) {
		CSS.highlights.delete(MATCHES);
		CSS.highlights.delete(ACTIVE);
		return;
	}
	CSS.highlights.set(MATCHES, new Highlight(...ranges));
	CSS.highlights.set(ACTIVE, new Highlight(ranges[active]));
}

/** True when `range` shows inside `box`, `margin` from its edges. */
function inView(box: HTMLElement, range: Range, margin = 0): boolean {
	const rect = range.getBoundingClientRect();
	const view = box.getBoundingClientRect();
	return rect.top >= view.top + margin && rect.bottom <= view.bottom - margin;
}

/** Scrolls `range` to the middle of `box`. */
function center(box: HTMLElement, range: Range) {
	const rect = range.getBoundingClientRect();
	const view = box.getBoundingClientRect();
	box.scrollTop += rect.top - view.top - view.height / 2;
}

/**
 * The chat view's find (Chat: Find, ⌘F / Ctrl+F). It takes the key only when
 * this conversation is where you are - focus or your last click is in it - so
 * the board's ⌘F (its search box) and a terminal's find keep theirs.
 */
export function useChatFind({
	root,
	content,
	scroll,
	trigger,
	onReveal,
}: {
	root: RefObject<HTMLElement | null>;
	content: RefObject<HTMLElement | null>;
	scroll: RefObject<HTMLElement | null>;
	/** Changes when the conversation does, so the matches are counted again. */
	trigger: unknown;
	/** A match is about to scroll into view: stop following the bottom. */
	onReveal: () => void;
}) {
	// The find bar's text; null while it is closed.
	const [query, setQuery] = useState<string | null>(null);
	const [active, setActive] = useState(0);
	const [ranges, setRanges] = useState<Range[]>([]);
	const input = useRef<HTMLInputElement>(null);
	// Scroll the active match into view on the next paint: set when you type or
	// step, not when a live reply only adds text.
	const reveal = useRef(false);
	const onRevealRef = useRef(onReveal);
	onRevealRef.current = onReveal;

	useEffect(() => {
		let lastInside = false;
		const track = (event: Event) => {
			lastInside = !!root.current?.contains(event.target as Node);
		};
		const onKey = (event: KeyboardEvent) => {
			const el = root.current;
			if (!el || el.getClientRects().length === 0) return;
			if (!isHotkey("CHAT_FIND", event)) return;
			const target = event.target as Node;
			const here =
				el.contains(target) || (target === document.body && lastInside);
			if (!here) return;
			event.preventDefault();
			event.stopPropagation();
			setQuery((prev) => prev ?? "");
			requestAnimationFrame(() => input.current?.select());
		};
		window.addEventListener("pointerdown", track, true);
		window.addEventListener("focusin", track, true);
		window.addEventListener("keydown", onKey, true);
		return () => {
			window.removeEventListener("pointerdown", track, true);
			window.removeEventListener("focusin", track, true);
			window.removeEventListener("keydown", onKey, true);
		};
	}, [root]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: trigger is the conversation changing
	useEffect(() => {
		const el = content.current;
		const found = el && query ? findRanges(el, query) : [];
		setRanges(found);
		setActive((index) => {
			if (!reveal.current)
				return Math.min(index, Math.max(found.length - 1, 0));
			// A new search starts at the first match from where you are reading.
			const top = scroll.current?.getBoundingClientRect().top ?? 0;
			return firstFrom(
				found.map((range) => range.getBoundingClientRect().top),
				top,
			);
		});
	}, [query, trigger]);

	useEffect(() => {
		paint(ranges, active);
		const range = ranges[active];
		const box = scroll.current;
		if (!reveal.current) return;
		reveal.current = false;
		if (!range || !box) return;
		// A match in a box that scrolls on its own (a turn's steps) scrolls there first.
		const inner = range.startContainer.parentElement?.closest<HTMLElement>(
			"[data-chat-scroll] .overflow-y-auto",
		);
		if (inner && box.contains(inner) && !inView(inner, range))
			center(inner, range);
		if (inView(box, range, 48)) return;
		onRevealRef.current();
		center(box, range);
	}, [ranges, active, scroll]);

	useEffect(() => () => paint([], 0), []);

	const step = (forward: boolean) => {
		if (ranges.length === 0) return;
		reveal.current = true;
		setActive(
			(index) => (index + (forward ? 1 : -1) + ranges.length) % ranges.length,
		);
	};
	const search = (text: string) => {
		reveal.current = true;
		setQuery(text);
	};
	const close = () => {
		setQuery(null);
		setRanges([]);
	};
	return {
		open: query !== null,
		bar:
			query === null ? null : (
				<ChatFindBar
					inputRef={input}
					query={query}
					active={active}
					total={ranges.length}
					onSearch={search}
					onStep={step}
					onClose={close}
				/>
			),
	};
}

const ICON_BUTTON =
	"flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40";

function ChatFindBar({
	inputRef,
	query,
	active,
	total,
	onSearch,
	onStep,
	onClose,
}: {
	inputRef: RefObject<HTMLInputElement | null>;
	query: string;
	active: number;
	total: number;
	onSearch: (text: string) => void;
	onStep: (forward: boolean) => void;
	onClose: () => void;
}) {
	const key = useHotkeyDisplay("CHAT_FIND").text;
	return (
		<div
			data-chat-find
			data-owns-esc
			className="mx-8 mt-2 flex items-center gap-0.5 self-end rounded-md border border-border bg-popover py-0.5 pr-1 pl-2"
		>
			<input
				ref={inputRef}
				value={query}
				placeholder="Find in conversation"
				aria-label="Find in conversation"
				title={key ? `Find in conversation (${key})` : undefined}
				spellCheck={false}
				className="w-48 bg-transparent py-1 text-xs text-foreground outline-none placeholder:text-faint-foreground"
				onChange={(event) => onSearch(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						onStep(!event.shiftKey);
					} else if (event.key === "Escape") {
						event.preventDefault();
						event.stopPropagation();
						onClose();
					}
				}}
			/>
			<span className="min-w-12 text-right text-xs tabular-nums text-muted-foreground">
				{query && (total ? `${active + 1}/${total}` : "No matches")}
			</span>
			<button
				type="button"
				title="Previous match (⇧↩)"
				aria-label="Previous match"
				disabled={total === 0}
				className={ICON_BUTTON}
				onClick={() => onStep(false)}
			>
				<LuChevronUp className="size-3.5" />
			</button>
			<button
				type="button"
				title="Next match (↩)"
				aria-label="Next match"
				disabled={total === 0}
				className={ICON_BUTTON}
				onClick={() => onStep(true)}
			>
				<LuChevronDown className="size-3.5" />
			</button>
			<button
				type="button"
				title="Close find (Esc)"
				aria-label="Close find"
				className={ICON_BUTTON}
				onClick={onClose}
			>
				<LuX className="size-3.5" />
			</button>
		</div>
	);
}
