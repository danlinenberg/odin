import { createFileRoute } from "@tanstack/react-router";
import { PermissionsSettings } from "./components/PermissionsSettings";

export const Route = createFileRoute("/_authenticated/settings/permissions/")({
	component: PermissionsSettingsPage,
});

function PermissionsSettingsPage() {
	return <PermissionsSettings />;
}
