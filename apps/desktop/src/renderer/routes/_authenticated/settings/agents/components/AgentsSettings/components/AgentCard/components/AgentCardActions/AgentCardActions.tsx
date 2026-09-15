import { Button } from "@odin/ui/button";
import { CardFooter } from "@odin/ui/card";

interface AgentCardActionsProps {
	isResetting: boolean;
	onReset: () => void;
}

export function AgentCardActions({
	isResetting,
	onReset,
}: AgentCardActionsProps) {
	return (
		<CardFooter className="mt-2 justify-end">
			<Button variant="outline" onClick={onReset} disabled={isResetting}>
				Reset to Defaults
			</Button>
		</CardFooter>
	);
}
