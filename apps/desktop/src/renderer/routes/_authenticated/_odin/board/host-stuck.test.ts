import { expect, test } from "bun:test";
import { hostsNotTakingLogins, loginFailing } from "./host-stuck";

test("a failed or stopped reconnect is a failing login; connecting is not", () => {
	expect(
		loginFailing(
			"Odin: could not reconnect: Connection lost before handshake - trying again in 9s",
		),
	).toBe(true);
	expect(
		loginFailing(
			"Odin: Stopped reconnecting to odin-prod after 6 tries (trying again by itself at 12:03): could not reconnect: Timed out.",
		),
	).toBe(true);
	expect(loginFailing("Odin: connecting to odin-prod...")).toBe(false);
	expect(loginFailing("")).toBe(false);
});

test("only a host with two or more failing sessions gets a banner", () => {
	expect(
		hostsNotTakingLogins(["odin-prod", "odin-remote", "odin-prod"]),
	).toEqual([{ host: "odin-prod", sessions: 2 }]);
	expect(hostsNotTakingLogins(["odin-prod"])).toEqual([]);
});
