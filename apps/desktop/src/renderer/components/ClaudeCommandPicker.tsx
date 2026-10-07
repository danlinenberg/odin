import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@odin/ui/select";
import { cn } from "@odin/ui/utils";
import {
	pickClaudeCommand,
	useClaudeCommand,
} from "renderer/stores/claude-command";

/**
 * Which of your Claude commands the next session starts with. Shows only when
 * there is a choice to make - two or more set in Settings → Sessions.
 */
export function ClaudeCommandPicker({ className }: { className?: string }) {
	const commands = useClaudeCommand((s) => s.commands);
	const active = useClaudeCommand((s) => s.active);
	const setActive = useClaudeCommand((s) => s.setActive);
	if (commands.length < 2) return null;
	return (
		<Select
			value={pickClaudeCommand(commands, active)}
			onValueChange={setActive}
		>
			<SelectTrigger
				size="sm"
				title="Claude command for new sessions"
				className={cn("h-6 max-w-[200px] font-mono text-[11px]", className)}
			>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{commands.map((command) => (
					<SelectItem key={command} value={command} className="font-mono">
						{command}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
