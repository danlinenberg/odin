import { expect, test } from "bun:test";
import { useClaudeCommand } from "renderer/stores/claude-command";
import { crowCli, crowScreenRepair } from "./useCrow";

test("crowCli: the raven runs on the picked model, Opus by default", () => {
	useClaudeCommand.setState({ commands: [], active: "" });
	expect(useClaudeCommand.getInitialState().crowModel).toBe("opus");
	expect(crowCli()).toStartWith(
		"claude --dangerously-skip-permissions --model opus --disallowedTools ",
	);
	useClaudeCommand.setState({ crowModel: "haiku" });
	expect(crowCli()).toStartWith(
		"claude --dangerously-skip-permissions --model haiku --disallowedTools ",
	);
	// Only a known alias reaches the shell; anything else is Opus again.
	useClaudeCommand.setState({ crowModel: "haiku; rm -rf ~" });
	expect(crowCli()).toStartWith(
		"claude --dangerously-skip-permissions --model opus --disallowedTools ",
	);
	useClaudeCommand.setState({ crowModel: "opus" });
});

test("crowScreenRepair: a quiet Working on Huginn is fixed from his screen", () => {
	const box = "─".repeat(60);
	// Spinner up: still mid-turn, leave it.
	expect(
		crowScreenRepair(
			`✻ Cogitating… (5m 0s · esc to interrupt)\n${box}\n> \n${box}`,
		),
	).toBeUndefined();
	// Back at his prompt with no Stop hook (Esc, Ctrl+C): out of Working.
	expect(
		crowScreenRepair(
			`✻ Cooked for 1m 30s\n${box}\n❯ \n${box}\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n`,
		),
	).toBe("review");
	// Claude gone, a bare shell left after a restart: idle.
	expect(crowScreenRepair("dan@mac ~/dev % ")).toBe("idle");
	expect(crowScreenRepair("")).toBe("idle");
});
