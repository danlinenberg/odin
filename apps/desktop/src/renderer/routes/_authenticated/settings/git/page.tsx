import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { useIsV2CloudEnabled } from "renderer/hooks/useIsV2CloudEnabled";
import { getVisibleItemsForSection } from "../utils/settings-items";
import { GitSettings } from "./components/GitSettings";
import { V2GitSettings } from "./components/V2GitSettings";

export const Route = createFileRoute("/_authenticated/settings/git/")({
	component: GitSettingsPage,
});

function GitSettingsPage() {
	const isV2CloudEnabled = useIsV2CloudEnabled();

	const visibleItems = useMemo(
		() =>
			getVisibleItemsForSection({
				section: "git",
				isV2: isV2CloudEnabled,
			}),
		[isV2CloudEnabled],
	);

	if (isV2CloudEnabled) {
		return <V2GitSettings />;
	}

	return <GitSettings visibleItems={visibleItems} />;
}
