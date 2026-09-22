import { existsSync, readFileSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { publicProcedure, router } from "../..";
import { parseVerdicts, reviewPath } from "./parse";

/** The Review screen's end of the sweep: read the answers, or throw them away. */

export const createBacklogReviewRouter = () => {
	return router({
		/**
		 * The verdicts as they stand on disk, and the path they came from.
		 *
		 * No file is the normal state — it means no sweep has finished — so that
		 * answers null verdicts rather than throwing. The path comes back either
		 * way: the renderer has to name it in the prompt it sends, and only this
		 * process knows whether ODIN_HOME_DIR moved it.
		 */
		read: publicProcedure.query(() => {
			const path = reviewPath();
			if (!existsSync(path)) return { path, verdicts: null, writtenAt: null };
			try {
				return {
					path,
					verdicts: parseVerdicts(readFileSync(path, "utf8")),
					writtenAt: statSync(path).mtimeMs,
				};
			} catch {
				// An unreadable file reads the same as no file: the screen offers a
				// sweep either way, and there is nothing here worth an error toast.
				return { path, verdicts: null, writtenAt: null };
			}
		}),

		/** Throw the answers away, so the next sweep can't be read as this one. */
		clear: publicProcedure.mutation(async () => {
			await rm(reviewPath(), { force: true });
			return { ok: true };
		}),
	});
};
