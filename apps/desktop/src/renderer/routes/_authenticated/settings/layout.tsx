import {
	createFileRoute,
	Outlet,
	useLocation,
	useNavigate,
} from "@tanstack/react-router";
import { useHotkeys } from "react-hotkeys-hook";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useSettingsOriginRoute } from "renderer/stores/settings-state";
import { NavigationControls } from "../components/NavigationControls";
import { SettingsSidebar } from "./components/SettingsSidebar";
import { useScrollReset } from "./hooks/useScrollReset";

export const Route = createFileRoute("/_authenticated/settings")({
	component: SettingsLayout,
});

function SettingsLayout() {
	const { data: platform } = electronTrpc.window.getPlatform.useQuery();
	const isMac = platform === undefined || platform === "darwin";
	const originRoute = useSettingsOriginRoute();
	const location = useLocation();
	const navigate = useNavigate();
	// Reset scroll to top when navigating to a different settings page.
	const contentRef = useScrollReset<HTMLDivElement>(location.pathname);
	useHotkeys(
		"escape",
		(event) => {
			if (document.querySelector('[data-state="open"]')) return;
			const segments = location.pathname.split("/").filter(Boolean);
			event.preventDefault();
			if (segments.length <= 2) {
				navigate({ to: originRoute });
				return;
			}

			const parent = `/${segments.slice(0, -1).join("/")}`;
			navigate({ to: parent });
		},
		{ enableOnFormTags: false, enableOnContentEditable: false },
		[navigate, location.pathname, originRoute],
	);

	const usesInnerSidebar =
		location.pathname.startsWith("/settings/projects") ||
		location.pathname.startsWith("/settings/agents");

	return (
		<div className="flex flex-col h-screen w-screen bg-tertiary">
			<div className="flex h-12 w-full items-center bg-tertiary">
				<div
					className="drag h-full shrink-0"
					style={{ width: isMac ? "96px" : "8px" }}
				/>
				<NavigationControls />
				<div className="drag h-full min-w-0 flex-1" />
			</div>

			<div className="flex flex-1 overflow-hidden bg-background">
				<SettingsSidebar />
				<div ref={contentRef} className="flex-1 overflow-auto">
					{usesInnerSidebar ? (
						<Outlet />
					) : (
						<div className="mx-auto max-w-4xl">
							<Outlet />
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
