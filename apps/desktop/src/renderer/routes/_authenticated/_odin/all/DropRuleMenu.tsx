import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuLabel,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@odin/ui/context-menu";
import { toast } from "@odin/ui/sonner";
import type { ReactNode } from "react";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import { useDoneStore } from "renderer/stores/done";
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
	if (!item || choices.length === 0) return children;
	// Mail: the sender's address is junk from now on, and the junk filter
	// takes the mail as an example for look-alikes from other senders.
	const ignoreLikeThis = () => {
		const sender = item.details.find(([label]) => label === "From")?.[1];
		electronTrpcClient.work.ignoreEmail
			.mutate({
				from: item.person,
				fromEmail: sender?.includes("@") ? sender : null,
				subject: item.title,
			})
			.then(
				() =>
					toast.success("Ignoring mail like this", {
						description: "Its sender is junk now, and similar mail with it",
					}),
				(error: Error) => toast.error(`Couldn't ignore it: ${error.message}`),
			);
		useDoneStore.getState().setDone(item.key, {
			title: item.title,
			source: item.source,
			url: item.url,
		});
	};
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
				{item.source === "Email" && (
					<>
						<ContextMenuItem onSelect={ignoreLikeThis} className="text-[12px]">
							Ignore mail like this
						</ContextMenuItem>
						<ContextMenuSeparator />
					</>
				)}
				<ContextMenuLabel className="text-[11px] text-muted-foreground">
					Drop {item.source} tasks like this from now on
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
