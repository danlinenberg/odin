import { expect, test } from "bun:test";
import { useClaudeCommand } from "renderer/stores/claude-command";
import { crowCli } from "./useCrow";

test("crowCli: the raven runs on the picked model, Haiku by default", () => {
	useClaudeCommand.setState({ commands: [], active: "" });
	expect(useClaudeCommand.getInitialState().crowModel).toBe("haiku");
	expect(crowCli()).toStartWith(
		"claude --dangerously-skip-permissions --model haiku --disallowedTools ",
	);
	useClaudeCommand.setState({ crowModel: "opus" });
	expect(crowCli()).toStartWith(
		"claude --dangerously-skip-permissions --model opus --disallowedTools ",
	);
	// Only a known alias reaches the shell; anything else is Haiku again.
	useClaudeCommand.setState({ crowModel: "opus; rm -rf ~" });
	expect(crowCli()).toStartWith(
		"claude --dangerously-skip-permissions --model haiku --disallowedTools ",
	);
	useClaudeCommand.setState({ crowModel: "haiku" });
});
