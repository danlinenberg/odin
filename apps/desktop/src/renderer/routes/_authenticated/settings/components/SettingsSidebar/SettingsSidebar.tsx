import { Link } from "@tanstack/react-router";
import { HiArrowLeft } from "react-icons/hi2";
import { useSettingsOriginRoute } from "renderer/stores/settings-state";
import { GeneralSettings } from "./GeneralSettings";

export function SettingsSidebar() {
	const originRoute = useSettingsOriginRoute();

	return (
		<div className="w-56 flex flex-col py-3 overflow-hidden bg-sidebar">
			{/* Back button */}
			<Link
				to={originRoute}
				className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
			>
				<HiArrowLeft className="h-4 w-4" />
				<span>Back</span>
			</Link>

			{/* Settings title */}
			<h1 className="text-lg font-semibold px-3 mb-4">Settings</h1>

			<div className="flex-1 overflow-y-auto min-h-0 border-t border-border pt-4 pb-4 px-3">
				<GeneralSettings />
			</div>
		</div>
	);
}
