import { expect, test } from "bun:test";
import { connectStep, setConnectStep } from "./connect-step";

test("a step keeps its start while it lasts, a new one starts over, null clears it", () => {
	setConnectStep("Reaching your Mac through the relay", 1_000);
	setConnectStep("Reaching your Mac through the relay", 5_000);
	expect(connectStep()).toEqual({
		text: "Reaching your Mac through the relay",
		since: 1_000,
	});
	setConnectStep("Your Mac is checking this phone", 6_000);
	expect(connectStep()?.since).toBe(6_000);
	setConnectStep(null);
	expect(connectStep()).toBeNull();
});
