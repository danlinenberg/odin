import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuLabel,
	ContextMenuTrigger,
} from "@odin/ui/context-menu";
import { toast } from "@odin/ui/sonner";
import type { ReactNode } from "react";
import type { AllItem } from "./all-items";
import { type DropRule, ruleLabel, rulesFor, useDropRules } from "./drop-rules";

/** Right-click a row: drop every task like it, now and as new ones arrive. */
export function DropRuleMenu({
	item,
	children,
}: {
	/** Unset when the row isn't in any feed any more: no menu, just the row. */
	item: AllItem | undefined;
	children: ReactNode;
}) {
	const choices = item ? rulesFor(item) : [];
	if (choices.length === 0) return children;
	const pick = (rule: DropRule) => {
		const { add, remove } = useDropRules.getState();
		add(rule);
		toast.success(`Dropping ${rule.source} tasks ${ruleLabel(rule)}`, {
			description: "Remove it from Filter on Tasks",
			action: { label: "Undo", onClick: () => remove(rule) },
		});
	};
	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
			<ContextMenuContent className="w-[320px]">
				<ContextMenuLabel className="text-[11px] text-muted-foreground">
					Drop {item?.source} tasks like this from now on
				</ContextMenuLabel>
				{choices.map((rule) => (
					<ContextMenuItem
						key={rule.field}
						onSelect={() => pick(rule)}
						className="text-[12px]"
					>
						<span className="truncate">{ruleLabel(rule)}</span>
					</ContextMenuItem>
				))}
			</ContextMenuContent>
		</ContextMenu>
	);
}
