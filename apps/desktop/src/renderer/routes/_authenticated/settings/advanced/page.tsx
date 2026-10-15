import { Tabs, TabsContent, TabsList, TabsTrigger } from "@odin/ui/tabs";
import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { SettingsPage } from "../components/SettingsPage";
import { CleanupSection } from "./components/CleanupSection";
import { RemoteServerSection } from "./components/RemoteServerSection";
import { SessionsSection } from "./components/SessionsSection";

export const Route = createFileRoute("/_authenticated/settings/advanced/")({
	component: AdvancedSettingsPage,
});

/**
 * Advanced holds what most people never change: one tab per area, one
 * component per tab, so the page can keep growing. Every tab stays mounted
 * (only hidden), so settings search still finds a row on a tab that isn't
 * open - and opens that tab first (SettingsSidebar's revealSetting).
 */
const TABS: { id: string; label: string; content: ReactNode }[] = [
	{ id: "sessions", label: "Sessions", content: <SessionsSection /> },
	{ id: "cleanup", label: "Cleanup", content: <CleanupSection /> },
	{ id: "remote", label: "Remote server", content: <RemoteServerSection /> },
];

function AdvancedSettingsPage() {
	return (
		<SettingsPage
			title="Advanced"
			description="Settings most people never need to change."
		>
			<Tabs defaultValue={TABS[0].id} className="gap-6">
				<TabsList>
					{TABS.map((tab) => (
						<TabsTrigger key={tab.id} value={tab.id} className="px-3">
							{tab.label}
						</TabsTrigger>
					))}
				</TabsList>
				{TABS.map((tab) => (
					<TabsContent
						key={tab.id}
						value={tab.id}
						forceMount
						className="flex flex-col gap-8 data-[state=inactive]:hidden"
					>
						{tab.content}
					</TabsContent>
				))}
			</Tabs>
		</SettingsPage>
	);
}
