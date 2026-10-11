import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Backlog tasks the raven was told to run one by one: Odin starts `ids[0]`
 * once `paneId` (the last one it started) stops working. Odin drives it, not
 * the raven - a Claude can't wait between turns, and a watcher script it
 * leaves behind dies with its shell.
 */
interface OneByOne {
	ids: string[];
	paneId?: string;
}
export const useOneByOne = create<OneByOne>()(
	persist((): OneByOne => ({ ids: [] }), { name: "odin-one-by-one" }),
);
