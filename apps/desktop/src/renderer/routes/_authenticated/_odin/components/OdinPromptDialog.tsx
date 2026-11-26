import { toast } from "@odin/ui/sonner";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { isHotkey, useHotkeyDisplay } from "renderer/hotkeys";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { usePersistedDraft } from "renderer/stores/chat-drafts";
import { launchErrorMessage } from "../hooks/useStartTask";
import { insertSkill, matchSkills, skillToken } from "./skill-picker";
import { WherePicker } from "./WherePicker";

/**
 * An attachment (image, video, PDF or text doc): either bytes to copy in
 * (`dataUrl`) or a file already on disk (`path`).
 */
export type PromptImage = { name: string; dataUrl?: string; path?: string };

const isPdf = (file: File) =>
	file.type === "application/pdf" || /\.pdf$/i.test(file.name);

/** A markdown or plain-text doc. macOS often gives a .md file no type at all. */
const TEXT_DOC = /\.(md|markdown|txt)$/i;
const isTextDoc = (file: File) =>
	TEXT_DOC.test(file.name) || /^text\/(markdown|plain)\b/.test(file.type);

/** What the new-session dialog takes on a pick, drop or paste. */
export const isPromptAttachable = (file: File): boolean =>
	file.type.startsWith("image/") ||
	file.type.startsWith("video/") ||
	isPdf(file) ||
	isTextDoc(file);

/**
 * A text doc with no path (pasted) as bytes with a type parseDataUrl knows, so
 * it lands as .md or .txt and not as an untyped blob.
 */
const asTypedTextDoc = (file: File): File =>
	new File([file], file.name, {
		type: /\.txt$/i.test(file.name) ? "text/plain" : "text/markdown",
	});

/**
 * Read a File as a data URL - the browser does the base64 for us, and unlike
 * btoa(String.fromCharCode(...)) it doesn't blow the stack on a big screenshot.
 */
export function readFile(file: File): Promise<PromptImage> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () =>
			resolve({
				name: file.name || "pasted image",
				dataUrl: String(reader.result),
			});
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}

/**
 * A line that only names a file: the chat box and the phone put a reply's
 * attachments on lines of their own before the words.
 */
const FILE_LINE = /^(?:\/|~\/)\S+$|^!?\[[^\]]*\]\(\S+\)$/;

/**
 * Board/tab name for a session: the prompt's first line, whole. The board card
 * wraps it; tabs and the drawer header truncate it in CSS. An attachment on a
 * line of its own is not the ask, so the first line of words after it is the
 * name - unless the file is all there is.
 */
export function sessionTitle(prompt: string, fallback: string): string {
	const lines = prompt
		.trim()
		.split("\n")
		.map((line) => line.trim());
	return (
		(lines.find((line) => line && !FILE_LINE.test(line)) ?? lines[0]) ||
		fallback
	);
}

/**
 * The prompt that restarts a lost card: its title, then whatever its brief adds.
 * A brief from an earlier restart already holds the title (once per restart),
 * and a reply's attachment lines may sit above it, so every copy is dropped
 * before the title goes back on top.
 */
export function restartPrompt(title: string, brief: string | null): string {
	const rest = (brief ?? "")
		.split("\n")
		.filter((line) => line.trim() !== title.trim())
		.join("\n")
		.trim();
	return rest ? `${title}\n\n${rest}` : title;
}

/**
 * A title cut to "…" (the old 60-char session cap, Slack's 120-char row title)
 * gets the rest of its line back from the text it was cut from - wherever in
 * that text the line sits, since a Slack title skips the greeting line.
 */
export function untruncatedTitle(title: string, source: string | null): string {
	if (!title.endsWith("…") || !source) return title;
	const start = source.indexOf(title.slice(0, -1));
	if (start < 0) return title;
	return source.slice(start).split("\n")[0]?.trim() || title;
}

/**
 * The text a card shows under its title: the session's whole brief, minus
 * what the title already says and bare links (a Jira/Notion brief is just
 * "title\nurl"). Null when nothing is left.
 */
export function cardBody(title: string, source: string | null): string | null {
	if (!source) return null;
	const body = source
		.split("\n")
		.filter((line) => {
			const text = line.trim();
			return text !== title.trim() && !/^<?https?:\/\/\S+>?$/.test(text);
		})
		.join("\n")
		.trim();
	return body || null;
}

/**
 * Session composer: a multi-line prompt plus images, videos and PDFs (paste, drop,
 * or pick). Attachments ride along as files in the workspace; the prompt
 * points the agent at their paths. Used where a session starts from a given
 * brief: a dead card started over, a task started with extra context.
 */
export function OdinPromptDialog({
	heading = "Work on Odin",
	note,
	placeholder = "What should the agent do in Odin?",
	defaultPrompt = "",
	wherePicker = false,
	defaultOnHost,
	submitLabel = "Start task",
	draftKey,
	onCancel,
	onSubmit,
}: {
	heading?: string;
	/** A line under the heading, when the dialog needs to say why it opened. */
	note?: ReactNode;
	placeholder?: string;
	/**
	 * Start the prompt from this text instead of empty - a dead card's brief,
	 * so starting over doesn't mean retyping the ask. Editable like any prompt.
	 */
	defaultPrompt?: string;
	/** This computer or the remote host, when one is set up. */
	wherePicker?: boolean;
	/** The picker's starting pick - one made before the dialog opened. */
	defaultOnHost?: boolean;
	submitLabel?: string;
	/**
	 * Keep the typed prompt under this name until it is sent: Cancel, a
	 * window reload or a restart brings it back the next time it opens.
	 */
	draftKey?: string;
	onCancel: () => void;
	onSubmit: (
		prompt: string,
		files: PromptImage[],
		/** The WherePicker pick; undefined leaves it to Settings. */
		onHost?: boolean,
	) => void | Promise<void>;
}) {
	const sendKeys = useHotkeyDisplay("SUBMIT").text;
	const [prompt, setPrompt, markSent] = usePersistedDraft(
		draftKey,
		defaultPrompt,
	);
	const [files, setFiles] = useState<PromptImage[]>([]);
	const [isDropping, setIsDropping] = useState(false);
	const [isStarting, setIsStarting] = useState(false);
	const fileInput = useRef<HTMLInputElement>(null);
	const [onHost, setOnHost] = useState(defaultOnHost);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	// Launching takes a couple of seconds (workspace + PTY), so wait on the
	// caller's promise and keep the button busy until it settles. If it rejects
	// or bails early the dialog stays open, unlocked, with the prompt intact.
	const start = async () => {
		if (isStarting) return;
		setIsStarting(true);
		try {
			await onSubmit(prompt, files, onHost);
			// Sent only if the submit closed the dialog: one that bailed stays
			// open with the prompt, and Cancel must still keep it. A tick
			// later, so the close has rendered.
			setTimeout(() => {
				if (!mounted.current) markSent();
			}, 0);
		} catch (error) {
			// A rejected launch used to be an unhandled rejection: the dialog just
			// sat there.
			toast.error(launchErrorMessage(error));
		} finally {
			setIsStarting(false);
		}
	};

	// Skill picker: type `/` and the agent's own skills/commands are searchable.
	// Picking one drops its `/name` into the prompt - the agent invokes it.
	const { data: skills = [] } = electronTrpc.skills.list.useQuery();
	const [menuClosed, setMenuClosed] = useState(false);
	const [selected, setSelected] = useState(0);
	const token = skillToken(prompt);
	const matches = useMemo(
		() => (token === undefined || menuClosed ? [] : matchSkills(skills, token)),
		[skills, token, menuClosed],
	);
	const activeIndex = Math.min(selected, Math.max(matches.length - 1, 0));
	const pickSkill = (name: string) => {
		setPrompt((current) => insertSkill(current, name));
		setSelected(0);
	};

	const addFiles = async (picked: FileList | null) => {
		const accepted = [...(picked ?? [])].filter(isPromptAttachable);
		if (accepted.length === 0) return;
		const read = await Promise.all(
			accepted.map(async (file) => {
				// A pasted video, PDF or doc (no path) still falls back to bytes.
				const path = !file.type.startsWith("image/")
					? window.webUtils.getPathForFile(file)
					: "";
				if (path) return { name: file.name, path };
				return readFile(isTextDoc(file) ? asTypedTextDoc(file) : file);
			}),
		);
		setFiles((previous) => [...previous, ...read]);
	};

	return (
		<>
			<button
				type="button"
				aria-label="Cancel"
				className="fixed inset-0 z-40 cursor-default bg-black/50 bg-none"
				onClick={onCancel}
			/>
			<div
				role="dialog"
				aria-modal="true"
				aria-label={heading}
				className="fixed left-1/2 top-[12vh] z-50 w-[620px] max-w-[92vw] -translate-x-1/2 rounded-[10px] border border-border bg-popover p-3.5 shadow-[0_18px_60px_rgba(0,0,0,0.6)]"
				onDragOver={(event) => {
					event.preventDefault();
					setIsDropping(true);
				}}
				onDragLeave={() => setIsDropping(false)}
				onDrop={(event) => {
					event.preventDefault();
					setIsDropping(false);
					void addFiles(event.dataTransfer.files);
				}}
			>
				<div className="mb-2 flex items-baseline justify-between gap-3 text-xs font-semibold text-foreground">
					{heading}
					<span className="truncate text-[11px] font-normal text-muted-foreground/70">
						{sendKeys} start · / for skills · paste or drop images, video, PDFs
						and .md files
					</span>
				</div>
				{note && (
					<div className="mb-2 text-[11px] leading-relaxed text-muted-foreground">
						{note}
					</div>
				)}
				<textarea
					// biome-ignore lint/a11y/noAutofocus: the dialog only exists after an explicit click, and typing is the next step
					autoFocus
					value={prompt}
					onChange={(event) => {
						setPrompt(event.target.value);
						setMenuClosed(false);
					}}
					onPaste={(event) => {
						if (event.clipboardData.files.length > 0) {
							event.preventDefault();
							void addFiles(event.clipboardData.files);
						}
					}}
					onKeyDown={(event) => {
						if (matches.length > 0) {
							// While the skill menu is open it owns these keys - Escape
							// dismisses the menu, not the whole dialog.
							if (event.key === "Escape") {
								event.preventDefault();
								setMenuClosed(true);
								return;
							}
							if (event.key === "ArrowDown" || event.key === "ArrowUp") {
								event.preventDefault();
								const step = event.key === "ArrowDown" ? 1 : matches.length - 1;
								setSelected((index) => (index + step) % matches.length);
								return;
							}
							if (event.key === "Enter" || event.key === "Tab") {
								if (!isHotkey("SUBMIT", event.nativeEvent)) {
									event.preventDefault();
									const match = matches[activeIndex];
									if (match) pickSkill(match.name);
									return;
								}
							}
						}
						if (event.key === "Escape") onCancel();
						else if (isHotkey("SUBMIT", event.nativeEvent)) {
							event.preventDefault();
							void start();
						}
					}}
					rows={7}
					placeholder={placeholder}
					className={`w-full resize-y rounded-[7px] border bg-card px-2.5 py-2 text-[13px] leading-[1.5] text-foreground outline-none placeholder:text-muted-foreground ${
						isDropping ? "border-primary" : "border-border focus:border-primary"
					}`}
				/>
				{matches.length > 0 && (
					<div className="mt-1.5 rounded-[7px] border border-border bg-card">
						<div className="max-h-[190px] overflow-y-auto py-1">
							{matches.map((skill, index) => (
								<button
									key={skill.name}
									type="button"
									onMouseMove={() => setSelected(index)}
									// The textarea keeps focus: mousedown fires before blur.
									onMouseDown={(event) => {
										event.preventDefault();
										pickSkill(skill.name);
									}}
									className={`flex w-full items-baseline gap-2 px-2.5 py-1 text-left ${
										index === activeIndex
											? "bg-primary/15 shadow-[inset_2px_0_0_var(--primary)]"
											: ""
									}`}
								>
									<span className="shrink-0 font-mono text-[12px] font-semibold text-foreground">
										/{skill.name}
									</span>
									<span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
										{skill.description}
									</span>
								</button>
							))}
						</div>
						{/* Full description of the highlighted row - hover or arrow keys.
						    A native `title` tooltip never appears in this window. */}
						{matches[activeIndex]?.description && (
							<div className="max-h-[110px] overflow-y-auto border-t border-border px-2.5 py-1.5 text-[11px] leading-[1.45] text-muted-foreground">
								{matches[activeIndex]?.description}
							</div>
						)}
					</div>
				)}
				{files.length > 0 && (
					<div className="mt-2 flex flex-wrap gap-1.5">
						{files.map((file, index) => (
							<button
								key={`${file.name}-${index}`}
								type="button"
								title={`Remove ${file.name}`}
								onClick={() =>
									setFiles((previous) =>
										previous.filter((_, at) => at !== index),
									)
								}
								className="group relative size-14 overflow-hidden rounded-[6px] border border-border"
							>
								{file.dataUrl?.startsWith("data:image/") ? (
									<img
										src={file.dataUrl}
										alt={file.name}
										className="size-full object-cover"
									/>
								) : (
									// A video, PDF or doc: nothing to draw, so the name is the
									// thumbnail.
									<span className="flex size-full flex-col items-center justify-center gap-0.5 bg-card px-1 text-[10px] leading-tight text-muted-foreground">
										<span className="text-[13px]">
											{/\.pdf$/i.test(file.name) || TEXT_DOC.test(file.name)
												? "📄"
												: "🎬"}
										</span>
										<span className="w-full truncate text-center">
											{file.name}
										</span>
									</span>
								)}
								<span className="absolute inset-0 hidden items-center justify-center bg-black/60 text-xs font-semibold text-danger group-hover:flex">
									remove
								</span>
							</button>
						))}
					</div>
				)}
				{/* The row wraps: with the where picker on it
				    outgrows the dialog, and a row that can't wrap pushed Cancel and
				    Start out past the edge. */}
				<div className="mt-3 flex flex-wrap items-center gap-1.5">
					<input
						ref={fileInput}
						type="file"
						accept="image/*,video/*,application/pdf,.md,.markdown,.txt,text/markdown,text/plain"
						multiple
						className="hidden"
						onChange={(event) => {
							void addFiles(event.target.files);
							event.target.value = "";
						}}
					/>
					<button
						type="button"
						onClick={() => fileInput.current?.click()}
						title="Add images, video, PDFs or .md and .txt files - you can also paste or drop them"
						className="h-7 shrink-0 rounded-[6px] bg-secondary px-2.5 text-[12px] font-semibold whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground"
					>
						+ Attach
					</button>
					{wherePicker && <WherePicker value={onHost} onChange={setOnHost} />}
					{/* One group, so a wrap moves Cancel and Start together to the
					    next line's right edge instead of splitting them. */}
					<div className="ml-auto flex shrink-0 items-center gap-1.5">
						<button
							type="button"
							onClick={onCancel}
							className="h-7 shrink-0 whitespace-nowrap rounded-[6px] px-2.5 text-[12px] font-semibold text-muted-foreground transition-colors hover:text-foreground"
						>
							Cancel
						</button>
						<button
							type="button"
							disabled={isStarting}
							onClick={() => void start()}
							className="flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[6px] bg-primary px-3 text-[12px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-default disabled:opacity-70"
						>
							{isStarting && (
								<span className="size-[9px] animate-spin rounded-full border border-current border-t-transparent" />
							)}
							{isStarting ? "Starting…" : submitLabel}
						</button>
					</div>
				</div>
			</div>
		</>
	);
}
