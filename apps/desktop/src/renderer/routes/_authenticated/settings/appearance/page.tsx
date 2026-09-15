import { createFileRoute } from "@tanstack/react-router";
import { AppearanceSettings } from "./components/AppearanceSettings";

export const Route = createFileRoute("/_authenticated/settings/appearance/")({
	component: AppearanceSettingsPage,
});

function AppearanceSettingsPage() {
	return <AppearanceSettings />;
}
