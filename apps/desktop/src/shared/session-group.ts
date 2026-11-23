/**
 * Session groups, like tab groups in a browser: a named, coloured set of
 * sessions you put together from a card's right-click menu. One session in a
 * group can be its leader; with "Note the others" on, each time the leader's
 * turn ends Odin types a short note into the other members. The other way,
 * each member's finished turn is noted to the leader (resumed when closed),
 * except a turn that only answered the leader's own note.
 *
 * A group lives on its members' panes and nowhere else (`Pane.odinGroup`), so
 * it persists with the session state like the star and priority do, and goes
 * away when its last session leaves it. The colour and the notify switch are
 * copied onto every member, so any one of them says what the group looks like.
 */

export const GROUP_COLORS = [
	"blue",
	"green",
	"amber",
	"red",
	"purple",
	"pink",
	"cyan",
	"grey",
] as const;

export type GroupColor = (typeof GROUP_COLORS)[number];

/** The hue each colour paints the chip and the card's edge, in every theme. */
export const GROUP_HEX: Record<GroupColor, string> = {
	blue: "#3b82f6",
	green: "#22c55e",
	amber: "#f59e0b",
	red: "#ef4444",
	purple: "#a855f7",
	pink: "#ec4899",
	cyan: "#06b6d4",
	grey: "#94a3b8",
};

export interface SessionGroup {
	name: string;
	color: GroupColor;
	/** This session leads the group. At most one member has it. */
	leader?: boolean;
	/** When the leader's turn ends, Odin notes it to the other members. */
	notify?: boolean;
}

interface Grouped {
	odinGroup?: SessionGroup;
}

export interface GroupSummary {
	name: string;
	color: GroupColor;
	count: number;
	notify: boolean;
	leaderPaneId?: string;
}

const MAX_NAME = 32;

/** A typed group name, trimmed and spaces collapsed; "" when nothing is left. */
export function groupName(raw: string): string {
	return raw.trim().replace(/\s+/g, " ").slice(0, MAX_NAME).trim();
}

/** Every group on the board, by name, with its member count and leader. */
export function listGroups(panes: Record<string, Grouped>): GroupSummary[] {
	const byName = new Map<string, GroupSummary>();
	for (const [paneId, pane] of Object.entries(panes)) {
		const group = pane.odinGroup;
		if (!group) continue;
		const summary = byName.get(group.name) ?? {
			name: group.name,
			color: group.color,
			count: 0,
			notify: !!group.notify,
		};
		summary.count++;
		if (group.leader) summary.leaderPaneId = paneId;
		byName.set(group.name, summary);
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The first colour no group wears yet, so a new group stands apart. */
export function nextGroupColor(groups: { color: GroupColor }[]): GroupColor {
	const used = new Set(groups.map((group) => group.color));
	return (
		GROUP_COLORS.find((color) => !used.has(color)) ??
		GROUP_COLORS[groups.length % GROUP_COLORS.length]
	);
}

/** `pane` without its group: the key is gone, never stored as undefined. */
function ungrouped<T extends Grouped>(pane: T): T {
	const { odinGroup: _, ...rest } = pane;
	return rest as T;
}

/**
 * Puts `paneId` in the group called `rawName` (made when it doesn't exist
 * yet, in the next free colour), or takes it out of its group when the name
 * is empty. A session joins as a plain member: it was the old group's leader,
 * not this one's.
 */
export function withGroup<T extends Grouped>(
	panes: Record<string, T>,
	paneId: string,
	rawName: string | undefined,
): Record<string, T> {
	const pane = panes[paneId];
	if (!pane) return panes;
	const name = groupName(rawName ?? "");
	if (!name) return { ...panes, [paneId]: ungrouped(pane) };
	if (pane.odinGroup?.name === name) return panes;
	const groups = listGroups(panes);
	const existing = groups.find((group) => group.name === name);
	const odinGroup: SessionGroup = {
		name,
		color: existing?.color ?? nextGroupColor(groups),
		...(existing?.notify ? { notify: true } : {}),
	};
	return { ...panes, [paneId]: { ...pane, odinGroup } };
}

/** Changes `name` on every member of the group. */
function updateGroup<T extends Grouped>(
	panes: Record<string, T>,
	name: string,
	update: (group: SessionGroup, paneId: string) => SessionGroup,
): Record<string, T> {
	let changed = false;
	const next = { ...panes };
	for (const [paneId, pane] of Object.entries(panes)) {
		if (pane.odinGroup?.name !== name) continue;
		next[paneId] = { ...pane, odinGroup: update(pane.odinGroup, paneId) };
		changed = true;
	}
	return changed ? next : panes;
}

/** Makes `paneId` its group's leader (the old leader steps down), or clears it. */
export function withLeader<T extends Grouped>(
	panes: Record<string, T>,
	paneId: string,
	leader: boolean,
): Record<string, T> {
	const name = panes[paneId]?.odinGroup?.name;
	if (!name) return panes;
	return updateGroup(panes, name, (group, id) => {
		const { leader: _, ...rest } = group;
		return leader && id === paneId ? { ...rest, leader: true } : rest;
	});
}

/** Turns the leader's note to the other members on or off for the group. */
export function withGroupNotify<T extends Grouped>(
	panes: Record<string, T>,
	name: string,
	notify: boolean,
): Record<string, T> {
	return updateGroup(panes, name, (group) => {
		const { notify: _, ...rest } = group;
		return notify ? { ...rest, notify: true } : rest;
	});
}

/** Recolours the group on every member. */
export function withGroupColor<T extends Grouped>(
	panes: Record<string, T>,
	name: string,
	color: GroupColor,
): Record<string, T> {
	return updateGroup(panes, name, (group) => ({ ...group, color }));
}

/**
 * The pane statuses where a turn has just ended: the agent left "working"
 * and now sits in Done ("review") or Idle. A question ("permission") is not
 * an end - the leader is waiting on you, not done.
 */
export function turnEnded(
	previous: string | undefined,
	next: string | undefined,
): boolean {
	return previous === "working" && (next === "review" || next === "idle");
}

/**
 * Who hears from the leader when its turn ends: every other member of its
 * group, when the group has the note on. Empty for a pane that leads nothing.
 */
export function leaderNoteTargets(
	panes: Record<string, Grouped>,
	leaderPaneId: string,
): string[] {
	const group = panes[leaderPaneId]?.odinGroup;
	if (!group?.leader || !group.notify) return [];
	return Object.entries(panes)
		.filter(
			([paneId, pane]) =>
				paneId !== leaderPaneId && pane.odinGroup?.name === group.name,
		)
		.map(([paneId]) => paneId);
}

/** How every leader note starts, so a member's answer to one can be told apart. */
const LEADER_NOTE_START = "[Odin] The leader of your session group";

/**
 * The note typed into a member when the leader's turn ends: which session,
 * and where its transcript is so the member can read the latest reply itself
 * (when both run on the same machine and the leader has one).
 */
export function leaderNote({
	group,
	leaderTitle,
	sessionId,
}: {
	group: string;
	leaderTitle: string;
	sessionId?: string;
}): string {
	const where = sessionId
		? ` Its transcript is ~/.claude/projects/*/${sessionId}.jsonl: read its last reply.`
		: "";
	return `${LEADER_NOTE_START} "${group}", "${leaderTitle}", just finished a turn.${where} If it changes what you are doing, update your work to match; if not, carry on.`;
}

/**
 * The leader a member reports to when its own turn ends: its group's leader,
 * whenever the group has one. Undefined for the leader itself, a session in
 * no group, or a group without a leader.
 */
export function memberNoteTarget(
	panes: Record<string, Grouped>,
	memberPaneId: string,
): string | undefined {
	const group = panes[memberPaneId]?.odinGroup;
	if (!group || group.leader) return undefined;
	return Object.entries(panes).find(
		([paneId, pane]) =>
			paneId !== memberPaneId &&
			pane.odinGroup?.name === group.name &&
			pane.odinGroup.leader,
	)?.[0];
}

/**
 * The member's turn answered nothing but the leader's own note: the latest
 * thing said to it is that note. Reporting such a turn back would start the
 * leader again and bounce between them, so it is not reported.
 */
export function answeredLeaderNote(
	messages: { role: string; text: string }[],
): boolean {
	const asked = messages.findLast((message) => message.role === "user");
	return !!asked?.text.trimStart().startsWith(LEADER_NOTE_START);
}

const GIST_CHARS = 400;

/** A reply in a few lines: its own TL;DR line when it has one, else its start. */
export function replyGist(reply: string): string {
	const tldr = reply.match(/^[\s*_#>-]*TL;?DR[*_]*\s*[:-]?[*_]*\s*(.+)$/im);
	const text = (tldr?.[1] ?? reply).replace(/\s+/g, " ").trim();
	return text.length > GIST_CHARS
		? `${text.slice(0, GIST_CHARS).trimEnd()}…`
		: text;
}

/**
 * The note typed into the leader when a member's turn ends: which session,
 * what its last reply said in short, and where its transcript is to read it
 * whole (when both run on the same machine).
 */
export function memberNote({
	group,
	memberTitle,
	reply,
	sessionId,
}: {
	group: string;
	memberTitle: string;
	reply?: string;
	sessionId?: string;
}): string {
	const gist = reply ? replyGist(reply) : "";
	const said = gist ? ` Its last reply, in short: "${gist}"` : "";
	const where = sessionId
		? ` Its transcript is ~/.claude/projects/*/${sessionId}.jsonl.`
		: "";
	return `[Odin] "${memberTitle}", a session in the group "${group}" you lead, just finished a turn.${said}${where} If it needs a next step from you, take it; if not, carry on.`;
}

/** A free group name for a session's own group: its title, or the title and a number. */
function freeGroupName(panes: Record<string, Grouped>, title: string): string {
	const base = groupName(title) || "Group";
	const taken = new Set(listGroups(panes).map((group) => group.name));
	for (let n = 1; ; n++) {
		const name = n === 1 ? base : `${base.slice(0, MAX_NAME - 3)} ${n}`;
		if (!taken.has(name)) return name;
	}
}

/**
 * A session about to start others: it gets a group to put them in. Its own
 * group when it has one, else a new group named after it. A group with no
 * leader yet takes it as its leader; in a group led by someone else it stays
 * a member, and what it starts joins that group.
 */
export function withLeadGroup<T extends Grouped & { odinTaskTitle?: string }>(
	panes: Record<string, T>,
	starterPaneId: string,
): Record<string, T> {
	const starter = panes[starterPaneId];
	if (!starter) return panes;
	let next = panes;
	let name = starter.odinGroup?.name;
	if (!name) {
		name = freeGroupName(panes, starter.odinTaskTitle ?? "");
		next = withGroup(next, starterPaneId, name);
	}
	return listGroups(next).find((group) => group.name === name)?.leaderPaneId
		? next
		: withLeader(next, starterPaneId, true);
}

/** A session started another one (a `/odin` start with `from=`): both in one group. */
export function withStartedBy<T extends Grouped & { odinTaskTitle?: string }>(
	panes: Record<string, T>,
	starterPaneId: string,
	childPaneId: string,
): Record<string, T> {
	if (!panes[childPaneId] || starterPaneId === childPaneId) return panes;
	const next = withLeadGroup(panes, starterPaneId);
	return withGroup(next, childPaneId, next[starterPaneId]?.odinGroup?.name);
}

/** The line a started session's prompt gets: who leads its group, and how it reports. */
export function ledByLine(leaderTitle: string, group: string): string {
	return `The Odin session "${leaderTitle}" started this session and leads its session group "${group}". Report to it: when your turn ends, Odin types your last reply into that session for you. To reach it sooner, use SendMessage to it if your agent list shows it.`;
}

/**
 * Board cards with each group kept together: a group's cards sit where its
 * most urgent member is (lowest `rank` of their statuses), the leader first,
 * then the other members in their order. `place` is the status a card sits
 * under; its own `status` is left as it is, so the card still says what it
 * is doing. Ungrouped cards keep their place; a group takes the place of its
 * first card in that status.
 */
export function keepGroupsTogether<
	C extends { pane: { id: string; odinGroup?: SessionGroup }; status: S },
	S extends string,
>(cards: C[], rank: (status: S) => number): (C & { place: S })[] {
	const groups = new Map<string, C[]>();
	for (const card of cards) {
		const name = card.pane.odinGroup?.name;
		if (name) groups.set(name, [...(groups.get(name) ?? []), card]);
	}
	const target = new Map<string, S>();
	for (const [name, members] of groups)
		target.set(
			name,
			members.reduce((a, b) => (rank(b.status) < rank(a.status) ? b : a))
				.status,
		);
	// Where each group lands: its first card already in its target status.
	const firstAt = new Map<string, number>();
	cards.forEach((card, index) => {
		const name = card.pane.odinGroup?.name;
		if (name && !firstAt.has(name) && card.status === target.get(name))
			firstAt.set(name, index);
	});
	const out: (C & { place: S })[] = [];
	cards.forEach((card, index) => {
		const name = card.pane.odinGroup?.name;
		if (!name) {
			out.push({ ...card, place: card.status });
			return;
		}
		if (firstAt.get(name) !== index) return;
		const members = groups.get(name) ?? [];
		const place = target.get(name) ?? card.status;
		out.push(
			...[
				...members.filter((member) => member.pane.odinGroup?.leader),
				...members.filter((member) => !member.pane.odinGroup?.leader),
			].map((member) => ({ ...member, place })),
		);
	});
	return out;
}
