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

test("parseHostLoad counts a capped user slice's headroom as the free memory", () => {
	const out = (max: string) =>
		[
			"MemTotal:       32761904 kB",
			"MemAvailable:    3250000 kB",
			"9.21 7.80 6.02 12/845 99121",
			"UserSliceCurrent: 28719439872",
			`UserSliceMax: ${max}`,
			"8",
		].join("\n");
	expect(parseHostLoad(out("28719448064"))?.memAvailableMb).toBe(0);
	expect(parseHostLoad(out("max"))?.memAvailableMb).toBe(3174);
	expect(parseHostLoad(out(""))?.memAvailableMb).toBe(3174);
});
