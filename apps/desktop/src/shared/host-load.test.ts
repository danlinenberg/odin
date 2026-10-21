import { expect, test } from "bun:test";
import { parseHostLoad } from "./host-load";

test("parseHostLoad reads memory, load and cores, and refuses partial output", () => {
	const out = [
		"MemTotal:       32761904 kB",
		"MemFree:          512000 kB",
		"MemAvailable:    3250000 kB",
		"SwapTotal:             0 kB",
		"9.21 7.80 6.02 12/845 99121",
		"8",
	].join("\n");
	expect(parseHostLoad(out)).toEqual({
		memAvailableMb: 3174,
		memTotalMb: 31994,
		load1: 9.21,
		cores: 8,
	});
	expect(parseHostLoad(out.split("\n").slice(0, 4).join("\n"))).toBeNull();
	expect(parseHostLoad("")).toBeNull();
});
