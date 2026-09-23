import { cn } from "@odin/ui/utils";
import { useEffect, useRef } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Highlight every occurrence of any search term (the server tokenises them). */
export function Highlight({ text, terms }: { text: string; terms: string[] }) {
	if (terms.length === 0) return <>{text}</>;
	const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
	return (
		<>
			{text.split(pattern).map((part, index) =>
				// split() with one capture group puts matches at the odd indices.
				index % 2 === 1 ? (
					<mark
						// biome-ignore lint/suspicious/noArrayIndexKey: split() output is positional
						key={index}
						className="rounded-[3px] bg-[#a394ff]/30 px-[1px] text-[#dcd6ff]"
					>
						{part}
					</mark>
				) : (
					part
				),
			)}
		</>
	);
}

/** The conversation itself, user/assistant turns only — no tool-call noise. */
export function TranscriptView({
	project,
	sessionId,
	terms = [],
}: {
	project?: string;
	sessionId: string;
	terms?: string[];
}) {
	const { data, isLoading, error } =
		electronTrpc.terminal.readClaudeTranscript.useQuery({ project, sessionId });
	const ref = useRef<HTMLDivElement>(null);
	// Jump to the first hit when arriving from a search, else the latest turn.
	useEffect(() => {
		if (!data) return;
		const target = ref.current?.querySelector("mark");
		if (target) target.scrollIntoView({ block: "center" });
		else if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
	}, [data]);

	if (error) {
		return (
			<div className="flex-1 select-text cursor-text px-4 py-3 text-[12px] text-[#f0647a]">
				{error.message}
			</div>
		);
	}
	return (
		<div
			ref={ref}
			className="min-h-0 flex-1 select-text cursor-text overflow-y-auto px-4 py-3"
		>
			{isLoading && <div className="text-[12px] text-[#8a8a97]">loading…</div>}
			{data?.messages.length === 0 && (
				<div className="text-[12px] text-[#8a8a97]">
					No prose turns in this transcript.
				</div>
			)}
			<div className="flex flex-col gap-3">
				{data?.messages.map((message, index) => (
					<div
						key={`${index}-${message.at ?? ""}`}
						className={cn(
							"rounded-[9px] border px-3 py-2",
							message.role === "user"
								? "border-[#2b2646] bg-[#171524]"
								: "border-[#25252e] bg-[#141418]",
						)}
					>
						<div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[.4px]">
							<span
								className={
									message.role === "user" ? "text-[#a394ff]" : "text-[#3ecf8e]"
								}
							>
								{message.role === "user" ? "you" : "claude"}
							</span>
							{message.at && (
								<span className="font-normal text-[#8a8a97]">
									{new Date(message.at).toLocaleString()}
								</span>
							)}
						</div>
						<div className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-[#d6d6dc]">
							<Highlight text={message.text} terms={terms} />
						</div>
					</div>
				))}
			</div>
		</div>
	);
}
