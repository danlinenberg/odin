import { useState } from "react";
import { LuSquareTerminal } from "react-icons/lu";
import {
	commandLabel,
	describeCommand,
	localCommand,
} from "../routes/_authenticated/_odin/board/action-items";
import { Markdown } from "./markdown";

/**
 * One `!` command as the board shows it: a button that says what it does, in
 * Claude's words or read from the command, and - where the board has its
 * hover - a "Show command" tap that opens the command itself, Claude's note on
 * it, and where it runs.
 */
export function RunCommand({
	command,
	note,
	run,
}: {
	command: string;
	/** Claude's line above the block: what it does. */
	note?: string;
	run: (command: string) => Promise<unknown>;
}) {
	const [status, setStatus] = useState<"idle" | "running" | "sent" | string>(
		"idle",
	);
	const [open, setOpen] = useState(false);
	const local = localCommand(command);
	const shown = local ?? command;
	const label = note ? commandLabel(note) : describeCommand(shown);
	const busy = status === "running" || status === "sent";
	return (
		<div className="flex flex-col gap-1">
			<button
				type="button"
				disabled={busy}
				onClick={() => {
					setStatus("running");
					run(command).then(
						() => setStatus("sent"),
						(error: Error) => setStatus(error.message),
					);
				}}
				className="flex min-h-8 max-w-full items-start gap-1.5 break-words rounded-lg border border-attention/40 px-3 py-1 text-left text-sm font-medium text-attention disabled:opacity-50"
			>
				<LuSquareTerminal className="mt-0.5 size-4 shrink-0" />
				<span>
					{status === "sent"
						? local
							? "Started on my Mac:"
							: "Sent:"
						: status === "running"
							? "Running…"
							: local
								? "Run on my Mac:"
								: "Run:"}{" "}
					{label}
				</span>
			</button>
			<div className="flex items-center gap-2">
				<button
					type="button"
					onClick={() => setOpen(!open)}
					aria-expanded={open}
					className="py-0.5 text-[13px] font-medium text-muted-foreground"
				>
					{open ? "Hide command" : "Show command"}
				</button>
				{!busy && status !== "idle" && (
					<span className="select-text text-[12px] text-danger">{status}</span>
				)}
			</div>
			{open && (
				<div className="border-l-2 border-attention/30 pl-2.5 text-[13px] text-muted-foreground">
					<code className="block select-text break-all rounded-md bg-secondary px-2 py-1 font-mono text-[12px] text-foreground">
						{local ? shown : `! ${command}`}
					</code>
					{note && (
						<div className="mt-1.5">
							<Markdown text={note} />
						</div>
					)}
					<p className="mt-1.5 opacity-80">
						{local
							? "Runs in this session's Shell on your Mac, where you can watch and stop it. When it ends, its output goes back to Claude."
							: "Runs in this session; its output goes back to Claude."}
					</p>
				</div>
			)}
		</div>
	);
}
