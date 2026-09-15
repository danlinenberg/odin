import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { useIsV2CloudEnabled } from "renderer/hooks/useIsV2CloudEnabled";
import { getVisibleItemsForSection } from "../utils/settings-items";
import { ExperimentalSettings } from "./components/ExperimentalSettings";

export const Route = createFileRoute("/_authenticated/settings/experimental/")({
	component: ExperimentalSettingsPage,
});

function ExperimentalSettingsPage() {
	const isV2CloudEnabled = useIsV2CloudEnabled();

	const visibleItems = useMemo(
		() =>
			getVisibleItemsForSection({
				section: "experimental",
				isV2: isV2CloudEnabled,
			}),
		[isV2CloudEnabled],
	);

	return <ExperimentalSettings visibleItems={visibleItems} />;
}
