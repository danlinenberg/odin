import { beforeEach, describe, expect, it } from "bun:test";
import {
	DEFAULT_PRIORITY,
	PRIORITY_LABELS,
	parseTask,
	priorityOf,
	taskPrompt,
	taskText,
	useOdinTasks,
	withPriority,
	withSkill,
} from "./useOdinTasks";

beforeEach(() => useOdinTasks.setState({ tasks: [] }));

describe("add", () => {
	it("splits the first line off as the title and keeps the rest as notes", () => {
		useOdinTasks.getState().add("Fix the drawer\n\nit renders blank on reload");
		const task = useOdinTasks.getState().tasks[0];
		if (!task) throw new Error("task was not added");
		expect(task.title).toBe("Fix the drawer");
		expect(task.notes).toBe("it renders blank on reload");
		expect(taskPrompt(task)).toBe(
			"Fix the drawer\n\nit renders blank on reload",
		);
	});

	it("ignores blank text and puts new tasks first", () => {
		const s = useOdinTasks.getState();
		s.add("   \n  ");
		expect(useOdinTasks.getState().tasks).toHaveLength(0);
		s.add("first");
		s.add("second");
		expect(useOdinTasks.getState().tasks.map((t) => t.title)).toEqual([
			"second",
			"first",
		]);
	});
});

describe("edit", () => {
	it("rewrites the task and drops it when edited to nothing", () => {
		useOdinTasks.getState().add("old");
		const id = useOdinTasks.getState().tasks[0]?.id ?? "";
		useOdinTasks.getState().edit(id, "new\nwith notes");
		expect(useOdinTasks.getState().tasks[0]?.title).toBe("new");
		expect(useOdinTasks.getState().tasks[0]?.notes).toBe("with notes");

		useOdinTasks.getState().edit(id, "  ");
		expect(useOdinTasks.getState().tasks).toHaveLength(0);
	});
});

describe("setPane / remove", () => {
	it("links the launched session and removes only the named task", () => {
		const s = useOdinTasks.getState();
		s.add("keep");
		s.add("start me");
		const [started, kept] = useOdinTasks.getState().tasks;
		useOdinTasks.getState().setPane(started?.id ?? "", "pane-1");
		expect(useOdinTasks.getState().tasks[0]?.paneId).toBe("pane-1");
		expect(useOdinTasks.getState().tasks[1]?.paneId).toBeUndefined();

		useOdinTasks.getState().remove(started?.id ?? "");
		expect(useOdinTasks.getState().tasks.map((t) => t.title)).toEqual([
			kept?.title,
		]);
	});
});

describe("priority", () => {
	it("reads leading !s off the first line and keeps them out of the prompt", () => {
		useOdinTasks.getState().add("!! Ship the fix\nbefore the demo");
		const task = useOdinTasks.getState().tasks[0];
		if (!task) throw new Error("task was not added");
		expect(task.priority).toBe(2);
		expect(task.title).toBe("Ship the fix");
		expect(taskPrompt(task)).toBe("Ship the fix\n\nbefore the demo");
		// The edit box has to round-trip, or editing silently demotes the task.
		// Medium is the no-"!"s case, so the box reads back without them.
		expect(taskText(task)).toBe("Ship the fix\n\nbefore the demo");
	});

	it("caps at three and leaves plain tasks at Medium", () => {
		const s = useOdinTasks.getState();
		s.add("!!!!! panic");
		s.add("calm");
		const [calm, panic] = useOdinTasks.getState().tasks;
		expect(panic?.priority).toBe(3);
		expect(panic?.title).toBe("panic");
		// Nothing typed means Medium — writing it down is already the decision.
		expect(calm?.priority).toBe(DEFAULT_PRIORITY);
		expect(taskText(calm ?? ({} as never))).toBe("calm");
	});

	it("reads a task stored before the default as Medium", () => {
		// 0 is what the store holds for tasks written when "None" was a level.
		expect(priorityOf({ priority: 0 })).toBe(DEFAULT_PRIORITY);
		expect(priorityOf({})).toBe(DEFAULT_PRIORITY);
		expect(priorityOf({ priority: 1 })).toBe(1);
	});
});

describe("withPriority", () => {
	it("is what the picker writes back — the !s change, the rest doesn't", () => {
		// Every level round-trips through the same text the box holds.
		expect(withPriority("Ship the fix\nbefore the demo", 3)).toBe(
			"!!! Ship the fix\nbefore the demo",
		);
		expect(withPriority("!!! Ship the fix", 1)).toBe("! Ship the fix");
		// Medium writes no "!"s at all — that's already what no "!"s means.
		expect(withPriority("!!! Ship the fix", DEFAULT_PRIORITY)).toBe(
			"Ship the fix",
		);
		// Out of range can't write a fourth "!" the parser would then drop.
		expect(withPriority("panic", 9)).toBe("!!! panic");
		expect(withPriority("calm", -1)).toBe("! calm");
	});

	it("names the level the store already stores", () => {
		useOdinTasks.getState().add(withPriority("Ship it", 2));
		const task = useOdinTasks.getState().tasks[0];
		if (!task) throw new Error("task was not added");
		expect(task.priority).toBe(2);
		expect(PRIORITY_LABELS[priorityOf(task)]).toBe("Medium");
		expect(taskText(task)).toBe("Ship it");
	});
});

describe("the skill on a task", () => {
	it("reads a leading /skill off the title and keeps the name clean", () => {
		useOdinTasks.getState().add("/ship-status Sweep the PR queue\n\nmine only");
		const task = useOdinTasks.getState().tasks[0];
		if (!task) throw new Error("task was not added");
		expect(task.skill).toBe("ship-status");
		expect(task.title).toBe("Sweep the PR queue");
		// The prompt is the human text; the skill rides separately to `launch`.
		expect(taskPrompt(task)).toBe("Sweep the PR queue\n\nmine only");
		// ...and the edit box gets the whole thing back.
		expect(taskText(task)).toBe("/ship-status Sweep the PR queue\n\nmine only");
	});

	it("survives a priority next to it, in either order of edit", () => {
		expect(parseTask("!!! /gdpr Purge the account")).toMatchObject({
			priority: 3,
			skill: "gdpr",
			title: "Purge the account",
		});
		expect(withSkill("!!! Purge the account", "gdpr")).toBe(
			"!!! /gdpr Purge the account",
		);
		expect(withPriority("/gdpr Purge the account", 3)).toBe(
			"!!! /gdpr Purge the account",
		);
		// Picking "No skill" takes it off and leaves everything else alone.
		expect(withSkill("!!! /gdpr Purge the account", "")).toBe(
			"!!! Purge the account",
		);
	});

	it("names the task after the skill when that's all you typed", () => {
		expect(parseTask("/ship-status")).toMatchObject({
			skill: "ship-status",
			title: "ship-status",
		});
	});

	it("is not fooled by a title that starts with a path", () => {
		expect(parseTask("/Users/dan/notes.md needs a rewrite")).toMatchObject({
			skill: "",
			title: "/Users/dan/notes.md needs a rewrite",
		});
	});

	it("clears on edit when the slash is taken out of the box", () => {
		const s = useOdinTasks.getState();
		s.add("/gdpr Purge the account");
		const id = useOdinTasks.getState().tasks[0]?.id ?? "";
		useOdinTasks.getState().edit(id, "Purge the account");
		expect(useOdinTasks.getState().tasks[0]?.skill).toBeUndefined();
	});
});
