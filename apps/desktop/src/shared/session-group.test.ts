import { describe, expect, it } from "bun:test";
import {
	answeredLeaderNote,
	groupName,
	leaderNote,
	leaderNoteTargets,
	listGroups,
	memberNote,
	memberNoteTarget,
	nextGroupColor,
	type SessionGroup,
	turnEnded,
	withGroup,
	withGroupColor,
	withGroupNotify,
	withLeader,
} from "./session-group";

type P = { id: string; odinGroup?: SessionGroup };
const panes = (...ids: string[]): Record<string, P> =>
	Object.fromEntries(ids.map((id) => [id, { id }]));

describe("session groups", () => {
	it("cleans a typed name", () => {
		expect(groupName("  release   work ")).toBe("release work");
		expect(groupName("   ")).toBe("");
		expect(groupName("x".repeat(50))).toHaveLength(32);
	});

	it("a new group takes the next free colour, a joiner takes the group's", () => {
		let state = withGroup(panes("a", "b", "c"), "a", "Release");
		expect(state.a.odinGroup).toEqual({ name: "Release", color: "blue" });
		state = withGroup(state, "b", "Docs");
		expect(state.b.odinGroup?.color).toBe("green");
		state = withGroup(state, "c", " Release ");
		expect(state.c.odinGroup?.color).toBe("blue");
		expect(listGroups(state)).toEqual([
			{ name: "Docs", color: "green", count: 1, notify: false },
			{ name: "Release", color: "blue", count: 2, notify: false },
		]);
	});

	it("an empty name takes the session out, and removes the key", () => {
		const state = withGroup(withGroup(panes("a"), "a", "Release"), "a", "");
		expect("odinGroup" in state.a).toBe(false);
		expect(listGroups(state)).toEqual([]);
	});

	it("rejoining the same group changes nothing", () => {
		const state = withGroup(panes("a"), "a", "Release");
		expect(withGroup(state, "a", "Release")).toBe(state);
	});

	it("colours run out without crashing", () => {
		const used = [
			"blue",
			"green",
			"amber",
			"red",
			"purple",
			"pink",
			"cyan",
			"grey",
		] as const;
		expect(nextGroupColor(used.map((color) => ({ color })))).toBe("blue");
	});

	it("one leader per group; moving groups drops the lead", () => {
		let state = withGroup(panes("a", "b"), "a", "Release");
		state = withGroup(state, "b", "Release");
		state = withLeader(state, "a", true);
		state = withLeader(state, "b", true);
		expect(state.a.odinGroup?.leader).toBeUndefined();
		expect(state.b.odinGroup?.leader).toBe(true);
		expect(listGroups(state)[0].leaderPaneId).toBe("b");
		state = withGroup(state, "b", "Docs");
		expect(state.b.odinGroup?.leader).toBeUndefined();
		expect(withLeader(panes("x"), "x", true)).toEqual(panes("x"));
	});

	it("colour and the note switch apply to every member and new joiners", () => {
		let state = withGroup(panes("a", "b", "c"), "a", "Release");
		state = withGroup(state, "b", "Release");
		state = withGroupColor(state, "Release", "pink");
		state = withGroupNotify(state, "Release", true);
		expect(state.a.odinGroup).toEqual({
			name: "Release",
			color: "pink",
			notify: true,
		});
		state = withGroup(state, "c", "Release");
		expect(state.c.odinGroup?.notify).toBe(true);
		state = withGroupNotify(state, "Release", false);
		expect("notify" in (state.b.odinGroup ?? {})).toBe(false);
	});

	it("only a leader with the note on reaches the other members", () => {
		let state = withGroup(panes("a", "b", "c", "d"), "a", "Release");
		state = withGroup(state, "b", "Release");
		state = withGroup(state, "c", "Release");
		state = withGroup(state, "d", "Docs");
		state = withLeader(state, "a", true);
		expect(leaderNoteTargets(state, "a")).toEqual([]);
		state = withGroupNotify(state, "Release", true);
		expect(leaderNoteTargets(state, "a")).toEqual(["b", "c"]);
		expect(leaderNoteTargets(state, "b")).toEqual([]);
		expect(leaderNoteTargets(state, "d")).toEqual([]);
	});

	it("a turn ends when working gives way to Done or Idle", () => {
		expect(turnEnded("working", "review")).toBe(true);
		expect(turnEnded("working", "idle")).toBe(true);
		expect(turnEnded("working", "permission")).toBe(false);
		expect(turnEnded("review", "idle")).toBe(false);
		expect(turnEnded(undefined, "review")).toBe(false);
	});

	it("the note names the group and leader, and the transcript when known", () => {
		const note = leaderNote({
			group: "Release",
			leaderTitle: "Ship the build",
			sessionId: "abc-123",
		});
		expect(note).toContain('"Release"');
		expect(note).toContain('"Ship the build"');
		expect(note).toContain("abc-123.jsonl");
		expect(leaderNote({ group: "R", leaderTitle: "T" })).not.toContain(
			"transcript",
		);
	});

	it("a member's finished turn goes to the leader, never a turn that only answered the leader", () => {
		let state = withGroup(panes("lead", "a", "b", "solo"), "lead", "Release");
		state = withGroup(state, "a", "Release");
		state = withGroup(state, "b", "Release");
		expect(memberNoteTarget(state, "a")).toBeUndefined();
		state = withLeader(state, "lead", true);
		expect(memberNoteTarget(state, "a")).toBe("lead");
		expect(memberNoteTarget(state, "lead")).toBeUndefined();
		expect(memberNoteTarget(state, "solo")).toBeUndefined();

		const fromLeader = leaderNote({ group: "Release", leaderTitle: "Plan" });
		expect(
			answeredLeaderNote([
				{ role: "user", text: "Fix the build" },
				{ role: "user", text: fromLeader },
				{ role: "assistant", text: "Noted, nothing changes here." },
			]),
		).toBe(true);
		expect(
			answeredLeaderNote([
				{ role: "user", text: fromLeader },
				{ role: "user", text: "Now fix the build" },
				{ role: "assistant", text: "Fixed." },
			]),
		).toBe(false);

		const note = memberNote({
			group: "Release",
			memberTitle: "Fix the build",
			reply: "Long story.\n\n**TL;DR:** the build is green again.\n\nMore.",
			sessionId: "abc",
		});
		expect(note).toContain('"Fix the build"');
		expect(note).toContain('"the build is green again."');
		expect(note).toContain("abc.jsonl");
		expect(answeredLeaderNote([{ role: "user", text: note }])).toBe(false);
		expect(
			memberNote({ group: "R", memberTitle: "T", reply: "x".repeat(900) }),
		).toContain(`${"x".repeat(400)}…`);
	});
});
