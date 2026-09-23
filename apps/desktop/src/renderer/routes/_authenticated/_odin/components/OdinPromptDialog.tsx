import { useMemo, useRef, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";

import { matchRepos, repoLabel } from "./repo-picker";
import { insertSkill, matchSkills, skillToken } from "./skill-picker";

/**
 * An attachment (image or video): either bytes to copy in (`dataUrl`) or a
 * file already on disk (`path`).
 */
export type PromptImage = { name: string; dataUrl?: string; path?: string };

/**
 * Read a File as a data URL — the browser does the base64 for us, and unlike
 * btoa(String.fromCharCode(...)) it doesn't blow the stack on a big screenshot.
 */
function readFile(file: File): Promise<PromptImage> {
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
 * Board/tab name for a session: the prompt's first line, whole. The board card
 * wraps it; tabs and the drawer header truncate it in CSS.
 */
export function sessionTitle(prompt: string, fallback: string): string {
	return prompt.trim().split("\n")[0]?.trim() || fallback;
}

/**
 * A title cut to "…" (the old 60-char session cap, Slack's 120-char row title)
 * gets the rest of its line back from the text it was cut from — wherever in
 * that text the line sits, since a Slack title skips the greeting line.
 */
export function untruncatedTitle(title: string, source: string | null): string {
	if (!title.endsWith("…") || !source) return title;
	const start = source.indexOf(title.slice(0, -1));
	if (start < 0) return title;
	return source.slice(start).split("\n")[0]?.trim() || title;
}

/**
 * Session composer: a multi-line prompt plus images and videos (paste, drop,
 * or pick). Attachments ride along as files in the workspace; the prompt
 * points the agent at their paths. Used by "Work on Odin" (Odin's own repo)
 * and the Dev Board's "New Session" (default repo).
 */
export function OdinPromptDialog({
	heading = "Work on Odin",
	note,
	placeholder = "What should the agent do in Odin?",
	defaultPrompt = "",
	repoPicker = false,
	onCancel,
	onSubmit,
}: {
	heading?: string;
	/** A line under the heading, when the dialog needs to say why it opened. */
	note?: string;
	placeholder?: string;
	/**
	 * Start the prompt from this text instead of empty — a dead card's brief,
	 * so starting over doesn't mean retyping the ask. Editable like any prompt.
	 */
	defaultPrompt?: string;
	/** Offer the machine's git checkouts as the session's directory. */
	repoPicker?: boolean;
	onCancel: () => void;
	onSubmit: (
		prompt: string,
		files: PromptImage[],
		/** Absolute repo path, or "" for the workspace default. */
		repo: string,
	) => void | Promise<void>;
}) {
	const [prompt, setPrompt] = useState(defaultPrompt);
	const [files, setFiles] = useState<PromptImage[]>([]);
	const [repoQuery, setRepoQuery] = useState("");
	const [isDropping, setIsDropping] = useState(false);
	const [isStarting, setIsStarting] = useState(false);
	const fileInput = useRef<HTMLInputElement>(null);

	// Launching takes a couple of seconds (workspace + PTY), so wait on the
	// caller's promise and keep the button busy until it settles. If it rejects
	// or bails early the dialog stays open, unlocked, with the prompt intact.
	const start = async () => {
		if (isStarting) return;
		setIsStarting(true);
		try {
			await onSubmit(prompt, files, repo);
		} finally {
			setIsStarting(false);
		}
	};

	// Skill picker: type `/` and the agent's own skills/commands are searchable.
	// Picking one drops its `/name` into the prompt — the agent invokes it.
	// ponytail: only a slash token at the END of the text opens the menu;
	// mid-text insertion isn't supported (nobody composes that way).
	const { data: skills = [] } = electronTrpc.skills.list.useQuery();
	const { data: repos = [] } = electronTrpc.repos.list.useQuery(undefined, {
		enabled: repoPicker,
	});
	const repoHits = matchRepos(repos, repoQuery);
	// One hit is a pick; none or several means the session falls back to the
	// workspace, so the dialog has to say which it is.
	const repo = repoHits.length === 1 ? (repoHits[0] as string) : "";
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
		const accepted = [...(picked ?? [])].filter(
			(file) =>
				file.type.startsWith("image/") || file.type.startsWith("video/"),
		);
		if (accepted.length === 0) return;
		const read = await Promise.all(
			accepted.map(async (file) => {
				// ponytail: a video that's already on disk is cited by path, never
				// base64'd — a screen recording through IPC wedges the renderer.
				// Pasted video (no path) still falls back to bytes.
				const path = file.type.startsWith("video/")
					? window.webUtils.getPathForFile(file)
					: "";
				return path ? { name: file.name, path } : readFile(file);
			}),
		);
		setFiles((previous) => [...previous, ...read]);
	};

	return (
		<>
			<button
				type="button"
				aria-label="Cancel"
				className="fixed inset-0 z-40 cursor-default bg-black/50"
				onClick={onCancel}
			/>
			<div
				role="dialog"
				aria-modal="true"
				aria-label={heading}
				className="fixed left-1/2 top-[12vh] z-50 w-[620px] max-w-[92vw] -translate-x-1/2 rounded-[10px] border border-[#2e2e38] bg-[#111114] p-3.5 shadow-[0_18px_60px_rgba(0,0,0,0.6)]"
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
				<div className="mb-2 text-xs font-semibold text-[#f5f5f7]">
					{heading}
					<span className="ml-1.5 font-normal text-[#8a8a97]">
						⌘⏎ start · esc cancel · / for skills · paste or drop images/video
					</span>
				</div>
				{note && (
					<div className="mb-2 text-[11px] leading-relaxed text-[#a5a5b3]">
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
							// While the skill menu is open it owns these keys — Escape
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
								if (!event.metaKey && !event.ctrlKey) {
									event.preventDefault();
									const match = matches[activeIndex];
									if (match) pickSkill(match.name);
									return;
								}
							}
						}
						if (event.key === "Escape") onCancel();
						else if (
							event.key === "Enter" &&
							(event.metaKey || event.ctrlKey) &&
							!event.nativeEvent.isComposing
						) {
							event.preventDefault();
							void start();
						}
					}}
					rows={7}
					placeholder={placeholder}
					className={`w-full resize-y rounded-[7px] border bg-[#16161b] px-2.5 py-2 text-[12.5px] leading-[1.5] text-[#f5f5f7] outline-none placeholder:text-[#8a8a97] ${
						isDropping
							? "border-[#3ecf8e]"
							: "border-[#2e2e38] focus:border-[#3ecf8e]"
					}`}
				/>
				{matches.length > 0 && (
					<div className="mt-1.5 rounded-[7px] border border-[#2e2e38] bg-[#16161b]">
						<div className="max-h-[190px] overflow-y-auto py-1">
							{matches.map((skill, index) => (
								<button
									key={skill.name}
									type="button"
									onMouseEnter={() => setSelected(index)}
									// The textarea keeps focus: mousedown fires before blur.
									onMouseDown={(event) => {
										event.preventDefault();
										pickSkill(skill.name);
									}}
									className={`flex w-full items-baseline gap-2 px-2.5 py-1 text-left ${
										index === activeIndex ? "bg-[#1f1f27]" : ""
									}`}
								>
									<span className="shrink-0 text-[12px] font-semibold text-[#3ecf8e]">
										/{skill.name}
									</span>
									<span className="min-w-0 flex-1 truncate text-[11px] text-[#a5a5b3]">
										{skill.description}
									</span>
								</button>
							))}
						</div>
						{/* Full description of the highlighted row — hover or arrow keys.
						    A native `title` tooltip never appears in this window. */}
						{matches[activeIndex]?.description && (
							<div className="max-h-[110px] overflow-y-auto border-t border-[#2e2e38] px-2.5 py-1.5 text-[11px] leading-[1.45] text-[#a5a5b3]">
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
								className="group relative size-14 overflow-hidden rounded-[6px] border border-[#2e2e38]"
							>
								{file.dataUrl ? (
									<img
										src={file.dataUrl}
										alt={file.name}
										className="size-full object-cover"
									/>
								) : (
									// A path-only attachment (video): no bytes to preview, so
									// the name is the thumbnail.
									<span className="flex size-full flex-col items-center justify-center gap-0.5 bg-[#16161b] px-1 text-[9px] leading-tight text-[#a5a5b3]">
										<span className="text-[13px]">🎬</span>
										<span className="w-full truncate text-center">
											{file.name}
										</span>
									</span>
								)}
								<span className="absolute inset-0 hidden items-center justify-center bg-black/60 text-xs font-semibold text-[#ff6b6b] group-hover:flex">
									remove
								</span>
							</button>
						))}
					</div>
				)}
				<div className="mt-2.5 flex items-center gap-1.5">
					<input
						ref={fileInput}
						type="file"
						accept="image/*,video/*"
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
						className="rounded-[6px] bg-[#1f1f27] px-2 py-[3px] text-[11px] font-semibold text-[#a5a5b3] transition-colors hover:text-[#f5f5f7]"
					>
						+ Image / Video
					</button>
					{repoPicker && (
						// ponytail: native <datalist> — Chromium does the search-as-you-type
						// popup over ~100 paths for free. Blank = the agent picks.
						<>
							<input
								list="odin-repos"
								aria-label="Repository"
								value={repoQuery}
								onChange={(event) => setRepoQuery(event.target.value)}
								placeholder="No repo (agent picks)"
								title={repo || "Search your git checkouts"}
								className={`w-[230px] rounded-[6px] bg-[#1f1f27] px-2 py-[3px] text-[11px] font-semibold outline-none placeholder:font-semibold placeholder:text-[#8a8a97] ${
									repo ? "text-[#3ecf8e]" : "text-[#a5a5b3]"
								}`}
							/>
							<datalist id="odin-repos">
								{repos.map((path) => (
									<option key={path} value={path}>
										{repoLabel(path)}
									</option>
								))}
							</datalist>
							{/* What the typed text resolved to — a half-typed name is a
							    valid pick, so say which repo it landed on. */}
							{repoQuery.trim() && (
								<span
									title={repo}
									className={`max-w-[180px] truncate text-[11px] font-semibold ${
										repo ? "text-[#3ecf8e]" : "text-[#f0647a]"
									}`}
								>
									{repo
										? `→ ${repoLabel(repo)}`
										: repoHits.length > 1
											? `${repoHits.length} matches`
											: "no match"}
								</span>
							)}
						</>
					)}
					<div className="flex-1" />
					<button
						type="button"
						onClick={onCancel}
						className="rounded-[6px] px-2 py-[3px] text-[11px] font-semibold text-[#a5a5b3] transition-colors hover:text-[#f5f5f7]"
					>
						Cancel
					</button>
					<button
						type="button"
						disabled={isStarting}
						onClick={() => void start()}
						className="flex items-center gap-1.5 rounded-[6px] bg-[#14301f] px-2.5 py-[3px] text-[11px] font-semibold text-[#3ecf8e] transition-colors hover:bg-[#1a4029] disabled:cursor-default disabled:opacity-70 disabled:hover:bg-[#14301f]"
					>
						{isStarting && (
							<span className="size-[9px] animate-spin rounded-full border border-current border-t-transparent" />
						)}
						{isStarting ? "Starting…" : "Start session"}
					</button>
				</div>
			</div>
		</>
	);
}
