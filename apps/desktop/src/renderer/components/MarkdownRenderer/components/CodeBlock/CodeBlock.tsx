import { ShowCode } from "@odin/ui/ai-elements/show-code";
import { Button } from "@odin/ui/button";
import { toast } from "@odin/ui/sonner";
import { mermaid } from "@streamdown/mermaid";
import { CheckIcon, CopyIcon, SparklesIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useTheme } from "renderer/stores";
import { Streamdown } from "streamdown";

const mermaidPlugins = { mermaid };

// A `text` fence is almost always a draft message to paste somewhere
// (Slack, email, a PR), so it reads as wrapped prose, not numbered code.
const PROSE_LANGUAGES = new Set(["text", "txt", "plaintext"]);

/** Hebrew or Arabic letters: a right-to-left draft, which rarely ends its lines with a period. */
const RTL_LETTERS = /[\u0590-\u05FF\u0600-\u06FF]/;

/** A word of a sentence: letters or a number, maybe with trailing punctuation. */
const PLAIN_WORD = /^[("'`]?[\p{L}\d][\p{L}\d'’.,:;%)?!"`-]*$/u;

/** A code comment, or a line that ends like code: a long English one is still code. */
const CODE_LINE = /^\s*(?:#|\/\/|--|\/\*|\*)|[{};]\s*$/;

/**
 * A long line that ends a sentence, or one that is mostly plain words: drafts
 * often skip the final period, while a command's flags, paths and `=` aren't words.
 */
function isSentence(line: string, codeAround: boolean): boolean {
	const words = line.trim().split(/\s+/);
	if (words.length < 12) return false;
	if (/[.?!]$/.test(line.trim())) return true;
	return (
		!codeAround &&
		words.filter((word) => PLAIN_WORD.test(word)).length / words.length >= 0.8
	);
}

export function looksLikeProse(code: string): boolean {
	const lines = code.split("\n");
	const codeAround = lines.some((line) => CODE_LINE.test(line));
	return (
		RTL_LETTERS.test(code) || lines.some((line) => isSentence(line, codeAround))
	);
}

type TextyOp = { insert: string; attributes?: Record<string, unknown> };

const SLACK_MARKUP =
	/<@([UW][A-Z0-9]+)(?:\|([^>]+))?>|\*([^*\n]+)\*|`([^`\n]+)`/g;

/**
 * The text as Slack's composer delta ("slack/texty"), the clipboard format
 * Slack itself writes on copy and reads on paste. It is the only way a pasted
 * <@U123> lands as a real mention: plain text stays literal. `names` gives
 * the mention its "@Name" label; without one it reads as the bare id.
 */
export function toSlackTexty(
	text: string,
	names: Record<string, string> = {},
): string {
	const ops: TextyOp[] = [];
	let last = 0;
	for (const match of text.matchAll(SLACK_MARKUP)) {
		const [whole, userId, label, bold, code] = match;
		if (match.index > last) ops.push({ insert: text.slice(last, match.index) });
		if (userId) {
			const name = `@${label ?? names[userId] ?? userId}`;
			ops.push({
				insert: name,
				attributes: {
					slackmention: {
						id: userId,
						label: name,
						mention: false,
						unverified: false,
					},
				},
			});
		} else if (bold) ops.push({ insert: bold, attributes: { bold: true } });
		else ops.push({ insert: code, attributes: { code: true } });
		last = match.index + whole.length;
	}
	ops.push({ insert: `${text.slice(last)}\n` });
	return JSON.stringify({ ops });
}

/** The right-to-left mark: invisible, it makes a line read right-to-left. */
const RLM = "\u200F";

/**
 * Each line with Hebrew or Arabic in it starts with RLM, so Slack lays it out
 * right-to-left: "1." and a closing "?" land on the right side, not the left.
 */
export function markRtlLines(text: string): string {
	return text
		.split("\n")
		.map((line) =>
			RTL_LETTERS.test(line) && !line.startsWith(RLM) ? RLM + line : line,
		)
		.join("\n");
}

/** A copy event can carry custom types that another Chromium app (Slack) reads. */
function copyWithSlackTexty(
	text: string,
	names: Record<string, string> | undefined,
): boolean {
	const onCopy = (event: ClipboardEvent) => {
		event.clipboardData?.setData("text/plain", text);
		event.clipboardData?.setData("slack/texty", toSlackTexty(text, names));
		event.preventDefault();
	};
	document.addEventListener("copy", onCopy);
	try {
		return document.execCommand("copy");
	} finally {
		document.removeEventListener("copy", onCopy);
	}
}

/**
 * A quote in a reply is usually a draft to paste somewhere (Slack, email, a
 * PR): it gets the paste block's Copy and Tune voice, and a Hebrew one reads
 * right-to-left. Copies the quote's text as it shows.
 */
export function QuoteBlock({ children }: { children?: ReactNode }) {
	const ref = useRef<HTMLQuoteElement>(null);
	const [isCopied, setIsCopied] = useState(false);
	// Read off the rendered text: dir="auto" skips the paragraphs inside,
	// which carry their own dir, and would read the button's "Copy".
	const [rtl, setRtl] = useState(false);
	useEffect(() => {
		setRtl(RTL_LETTERS.test(ref.current?.innerText.slice(0, 200) ?? ""));
	});
	const copy = async () => {
		const text = ref.current?.innerText.trim() ?? "";
		try {
			const marked = markRtlLines(text);
			if (!copyWithSlackTexty(marked, undefined))
				await navigator.clipboard.writeText(marked);
			setIsCopied(true);
			setTimeout(() => setIsCopied(false), 2000);
		} catch {
			// clipboard unavailable
		}
	};
	return (
		// A Hebrew draft puts its bar on the right and Copy on the left.
		<div
			dir={rtl ? "rtl" : "ltr"}
			className="relative my-4 border-s-4 border-muted-foreground/30 py-1 ps-4 pe-20"
		>
			<blockquote ref={ref} className="italic">
				{children}
			</blockquote>
			<TuneVoice draft={() => ref.current?.innerText.trim() ?? ""} />
			<CopyButton copied={isCopied} onClick={copy} className="end-0 top-0" />
		</div>
	);
}

function CopyButton({
	copied,
	onClick,
	className,
}: {
	copied: boolean;
	onClick: () => void;
	className: string;
}) {
	return (
		<Button
			className={`absolute h-7 gap-1.5 px-2 text-xs ${className}`}
			onClick={onClick}
			size="sm"
			variant="ghost"
		>
			{copied ? (
				<CheckIcon className="size-3.5" />
			) : (
				<CopyIcon className="size-3.5" />
			)}
			{copied ? "Copied" : "Copy"}
		</Button>
	);
}

/**
 * "Tune voice" under a draft: one line on how it should sound, kept as a
 * correction in Your voice so every later draft follows it. "Rewrite it" takes
 * what I would have written instead, and Your voice learns from the difference.
 * `draft` reads the draft's text when the rewrite opens.
 */
function TuneVoice({ draft }: { draft: () => string }) {
	const [mode, setMode] = useState<"closed" | "rule" | "rewrite">("closed");
	const [note, setNote] = useState("");
	const [rewrite, setRewrite] = useState("");
	const [saved, setSaved] = useState<string | null>(null);
	const close = (message: string | null) => {
		setNote("");
		setRewrite("");
		setMode("closed");
		setSaved(message);
	};
	// A failed save keeps the form open with what was typed.
	const saveFailed = (error: { message: string }) =>
		toast.error("Could not save to Your voice", {
			description: error.message,
		});
	const addNote = electronTrpc.voice.addNote.useMutation({
		onSuccess: () => close("Saved to Your voice"),
		onError: saveFailed,
	});
	const learn = electronTrpc.voice.learnFromRewrite.useMutation({
		onSuccess: (learning) =>
			close(
				learning
					? "Learning from your version"
					: "Turn on Your voice in Settings to learn from it",
			),
		onError: saveFailed,
	});
	const openRewrite = () => {
		setRewrite(draft());
		setMode("rewrite");
	};
	const linkClass = "text-xs text-muted-foreground hover:text-foreground";
	if (mode === "closed")
		return (
			<button
				type="button"
				onClick={() => {
					setSaved(null);
					setMode("rule");
				}}
				className={`mt-2 flex items-center gap-1 ${linkClass}`}
			>
				<SparklesIcon className="size-3" />
				{saved ?? "Tune voice"}
			</button>
		);
	if (mode === "rewrite")
		return (
			<form
				className="mt-2 flex flex-col gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					if (rewrite.trim())
						learn.mutate({ draft: draft(), rewrite: rewrite.trim() });
				}}
			>
				<textarea
					// biome-ignore lint/a11y/noAutofocus: opened by a click on Rewrite it
					autoFocus
					dir="auto"
					rows={Math.min(12, Math.max(3, rewrite.split("\n").length + 1))}
					value={rewrite}
					onChange={(event) => setRewrite(event.target.value)}
					onKeyDown={(event) => event.key === "Escape" && close(null)}
					placeholder="What you would have written instead"
					className="min-w-0 resize-y rounded border border-border bg-background px-2 py-1 font-sans text-xs not-italic"
				/>
				<div className="flex items-center gap-3">
					<Button
						type="submit"
						size="sm"
						className="h-7 px-2 text-xs"
						disabled={!rewrite.trim() || learn.isPending}
					>
						Save
					</Button>
					<button
						type="button"
						onClick={() => setMode("rule")}
						className={linkClass}
					>
						Write a rule instead
					</button>
				</div>
			</form>
		);
	return (
		<form
			className="mt-2 flex items-center gap-2"
			onSubmit={(event) => {
				event.preventDefault();
				if (note.trim()) addNote.mutate({ note });
			}}
		>
			<input
				// biome-ignore lint/a11y/noAutofocus: opened by a click on Tune voice
				autoFocus
				dir="auto"
				value={note}
				onChange={(event) => setNote(event.target.value)}
				onKeyDown={(event) => event.key === "Escape" && close(null)}
				placeholder="How should drafts sound? e.g. never link a PR unless they approve it"
				className="h-7 min-w-0 flex-1 rounded border border-border bg-background px-2 text-xs"
			/>
			<Button
				type="submit"
				size="sm"
				className="h-7 px-2 text-xs"
				disabled={!note.trim() || addNote.isPending}
			>
				Save
			</Button>
			<button type="button" onClick={openRewrite} className={linkClass}>
				Rewrite it
			</button>
		</form>
	);
}

function PasteBlock({ text }: { text: string }) {
	const [isCopied, setIsCopied] = useState(false);
	// Looked up on render, not on click: the copy has to run inside the click.
	const ids = [
		...new Set(Array.from(text.matchAll(/<@([UW][A-Z0-9]+)>/g), (m) => m[1])),
	];
	const { data: names } = electronTrpc.slack.userNames.useQuery(
		{ ids },
		{ enabled: ids.length > 0, staleTime: Number.POSITIVE_INFINITY },
	);
	const copy = async () => {
		try {
			const marked = markRtlLines(text);
			if (!copyWithSlackTexty(marked, names))
				await navigator.clipboard.writeText(marked);
			setIsCopied(true);
			setTimeout(() => setIsCopied(false), 2000);
		} catch {
			// clipboard unavailable
		}
	};
	return (
		// A Hebrew draft reads right-to-left: dir="auto" reads the text, which
		// comes before the button, so the bar and Copy flip sides with it.
		<div
			dir="auto"
			className="group relative my-4 rounded-md border border-border border-s-2 border-s-primary/60 bg-muted/30 py-3 ps-4 pe-20"
		>
			<div className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-foreground">
				{text.split(/<@([UW][A-Z0-9]+)>/).map((part, i) =>
					i % 2 ? (
						// A mention reads as the person it tags, like Slack shows it.
						// biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed string, never reordered
						<span className="rounded bg-primary/15 px-0.5 text-primary" key={i}>
							@{names?.[part] ?? part}
						</span>
					) : (
						part
					),
				)}
			</div>
			<TuneVoice draft={() => text} />
			<CopyButton copied={isCopied} onClick={copy} className="end-2 top-2" />
		</div>
	);
}

interface CodeNode {
	position?: {
		start: { line: number; column: number };
		end: { line: number; column: number };
	};
}

interface CodeBlockProps {
	children?: ReactNode;
	className?: string;
	node?: CodeNode;
}

export function CodeBlock({ children, className, node }: CodeBlockProps) {
	const theme = useTheme();
	const isDark = theme?.type !== "light";

	const match = /language-(\w+)/.exec(className || "");
	const language = match ? match[1] : undefined;
	const codeString = String(children).replace(/\n$/, "");

	const isInline =
		!language && node?.position?.start.line === node?.position?.end.line;

	if (isInline) {
		return (
			<code className="px-1.5 py-0.5 rounded bg-muted font-mono text-sm">
				{children}
			</code>
		);
	}

	if (language === "mermaid") {
		return (
			<Streamdown
				mode="static"
				plugins={mermaidPlugins}
				mermaid={{ config: { theme: isDark ? "dark" : "default" } }}
			>
				{`\`\`\`mermaid\n${codeString}\n\`\`\``}
			</Streamdown>
		);
	}

	if (language ? PROSE_LANGUAGES.has(language) : looksLikeProse(codeString)) {
		return <PasteBlock text={codeString} />;
	}

	return (
		<ShowCode
			className="my-4"
			// biome-ignore lint/suspicious/noExplicitAny: ShowCode accepts BundledLanguage; language is an untyped string here
			language={language as any}
			code={codeString}
			showLineNumbers
		/>
	);
}
