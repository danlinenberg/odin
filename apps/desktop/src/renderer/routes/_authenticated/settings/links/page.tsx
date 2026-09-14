import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { useIsV2CloudEnabled } from "renderer/hooks/useIsV2CloudEnabled";
import { getVisibleItemsForSection } from "../utils/settings-items";
import { LinksSettings } from "./components/LinksSettings";

export const Route = createFileRoute("/_authenticated/settings/links/")({
	component: LinksSettingsPage,
});

function LinksSettingsPage() {
	const isV2CloudEnabled = useIsV2CloudEnabled();

	const visibleItems = useMemo(
		() =>
			getVisibleItemsForSection({
				section: "links",
				isV2: isV2CloudEnabled,
			}),
		[isV2CloudEnabled],
	);

	return <LinksSettings visibleItems={visibleItems} />;
}
