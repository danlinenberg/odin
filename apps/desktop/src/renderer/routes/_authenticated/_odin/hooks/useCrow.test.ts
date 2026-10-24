import { expect, test } from "bun:test";
import { useClaudeCommand } from "renderer/stores/claude-command";
import { crowCli } from "./useCrow";

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
