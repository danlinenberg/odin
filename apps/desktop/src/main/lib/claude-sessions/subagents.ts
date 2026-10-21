import { open, stat } from "node:fs/promises";
import {
	foldSubagentLine,
	type Subagent,
	subagentList,
} from "shared/subagents";
import { projectsRoot, transcriptOf } from "./claude-sessions";

/**
 * The fold so far, per session: where the file was read to and the agents
 * found. A poll on an unchanged file is a stat; a growing one costs only its
 * new bytes, so the drawer can ask every couple of seconds while an agent is
 * out. The whole file is scanned once, the first time it is asked about.
 */
interface Folded {
	path: string;
	size: number;
	mtimeMs: number;
	/** Bytes folded so far - a whole number of lines. */
	offset: number;
	/** The line still being written, carried to the next read. */
	remainder: Buffer;
	agents: Map<string, Subagent>;
}

const folded = new Map<string, Folded>();

/**
 * The subagents a session has launched, newest first - see `shared/subagents`.
 * An empty list when there is no transcript on this machine: nothing is known
 * about such a session's agents, which is what the board shows.
 */
export async function readSubagents({
	sessionId,
	root = projectsRoot(),
}: {
	sessionId: string;
	root?: string;
}): Promise<Subagent[]> {
	const file = await transcriptOf(sessionId, root);
	if (!file) return [];
	const { size, mtimeMs } = await stat(file.path);
	let fold = folded.get(sessionId);
	if (
		fold &&
		fold.path === file.path &&
		fold.size === size &&
		fold.mtimeMs === mtimeMs
	)
		return subagentList(fold.agents);
	// Another copy took over (the one still being written wins), or the
	// file was rewritten shorter: start again from the top.
	if (!fold || fold.path !== file.path || size < fold.offset)
		fold = {
			path: file.path,
			size: 0,
			mtimeMs: 0,
			offset: 0,
			remainder: Buffer.alloc(0),
			agents: new Map(),
		};
	if (size > fold.offset) {
		const handle = await open(file.path, "r");
		const fresh = Buffer.alloc(size - fold.offset);
		try {
			await handle.read(fresh, 0, fresh.length, fold.offset);
		} finally {
			await handle.close();
		}
		const bytes = Buffer.concat([fold.remainder, fresh]);
		let at = 0;
		for (
			let cut = bytes.indexOf(10, at);
			cut >= 0;
			cut = bytes.indexOf(10, at)
		) {
			foldSubagentLine(fold.agents, bytes.subarray(at, cut).toString("utf-8"));
			at = cut + 1;
		}
		// A copy, so the chunk just read can be collected.
		fold.remainder = Buffer.from(bytes.subarray(at));
		fold.offset = size;
	}
	fold.size = size;
	fold.mtimeMs = mtimeMs;
	folded.set(sessionId, fold);
	return subagentList(fold.agents);
}
