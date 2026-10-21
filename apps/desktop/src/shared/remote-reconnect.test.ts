import { describe, expect, it } from "bun:test";
import { remoteCardsToReconnect, tmuxSession } from "./remote-reconnect";

const card = (paneId: string, host = "odin-remote") => ({
	paneId,
	host,
	sessionId: `${paneId}-session`,
});

describe("remoteCardsToReconnect", () => {
	it("picks the cards whose tmux session is still up on their host", () => {
		const live = { "odin-remote": [tmuxSession("a-session"), "other"] };
		expect(remoteCardsToReconnect([card("a"), card("b")], live)).toEqual([
			card("a"),
		]);
	});

	it("picks nothing on a host it has no list for", () => {
		const cards = [card("a", "unreachable"), card("b", "unasked")];
		expect(remoteCardsToReconnect(cards, { unreachable: null })).toEqual([]);
	});

	it("checks each card against its own host", () => {
		const live = { h1: [tmuxSession("b-session")], h2: [] };
		expect(remoteCardsToReconnect([card("b", "h2")], live)).toEqual([]);
	});
});
