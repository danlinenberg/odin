import { createFileRoute } from "@tanstack/react-router";
import { RingtonesSettings } from "./components/RingtonesSettings";

export const Route = createFileRoute("/_authenticated/settings/ringtones/")({
	component: RingtonesSettingsPage,
});

function RingtonesSettingsPage() {
	return <RingtonesSettings />;
}
