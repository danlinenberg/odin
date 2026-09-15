import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { useIsV2CloudEnabled } from "renderer/hooks/useIsV2CloudEnabled";
import { getVisibleItemsForSection } from "../utils/settings-items";
import { BehaviorSettings } from "./components/BehaviorSettings";

export const Route = createFileRoute("/_authenticated/settings/behavior/")({
	component: BehaviorSettingsPage,
});

function BehaviorSettingsPage() {
	const isV2CloudEnabled = useIsV2CloudEnabled();

	const visibleItems = useMemo(
		() =>
			getVisibleItemsForSection({
				section: "behavior",
				isV2: isV2CloudEnabled,
			}),
		[isV2CloudEnabled],
	);

	return <BehaviorSettings visibleItems={visibleItems} />;
}
