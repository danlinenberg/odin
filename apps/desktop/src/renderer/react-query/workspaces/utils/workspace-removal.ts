type WorkspaceLike = {
	id: string;
	tabOrder: number;
};

type SectionLike = {
	id: string;
	workspaces: WorkspaceLike[];
};

type TopLevelItemLike = {
	id: string;
	kind: "workspace" | "section";
	tabOrder: number;
};

type WorkspaceGroupLike = {
	workspaces: WorkspaceLike[];
	sections: SectionLike[];
	topLevelItems: TopLevelItemLike[];
};

function hasVisibleWorkspaces(group: WorkspaceGroupLike): boolean {
	return (
		group.workspaces.length > 0 ||
		group.sections.some((section) => section.workspaces.length > 0)
	);
}

export function removeWorkspaceFromGroups<TGroup extends WorkspaceGroupLike>(
	groups: readonly TGroup[],
	workspaceId: string,
): TGroup[] {
	return groups
		.map((group) => {
			const isTopLevelWorkspace = group.workspaces.some(
				(workspace) => workspace.id === workspaceId,
			);
			const workspaces = group.workspaces.filter(
				(workspace) => workspace.id !== workspaceId,
			);
			// Keep empty sections: getAllGrouped returns user-created sections even
			// when they have no workspaces, so the optimistic cache should match.
			const sections = group.sections.map((section) => ({
				...section,
				workspaces: section.workspaces.filter(
					(workspace) => workspace.id !== workspaceId,
				),
			}));

			return {
				...group,
				workspaces,
				sections,
				topLevelItems: isTopLevelWorkspace
					? group.topLevelItems.filter((item) => item.id !== workspaceId)
					: group.topLevelItems,
			} as TGroup;
		})
		.filter(hasVisibleWorkspaces);
}
