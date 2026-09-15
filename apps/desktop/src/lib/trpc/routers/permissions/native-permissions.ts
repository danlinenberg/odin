import type {
	shell as electronShell,
	systemPreferences as electronSystemPreferences,
} from "electron";
import { checkFullDiskAccess } from "./full-disk-access";

export const PERMISSION_SETTINGS_URLS = {
	fullDiskAccess:
		"x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
	accessibility:
		"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
	appleEvents:
		"x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Automation",
} as const;

type ShellApi = Pick<typeof electronShell, "openExternal">;
type SystemPreferencesApi = Pick<
	typeof electronSystemPreferences,
	"isTrustedAccessibilityClient"
>;

function getElectronShell(): ShellApi {
	return (require("electron") as Partial<typeof import("electron")>)
		.shell as ShellApi;
}

function getElectronSystemPreferences(): SystemPreferencesApi | undefined {
	return (require("electron") as Partial<typeof import("electron")>)
		.systemPreferences;
}

export function checkAccessibility({
	systemPreferencesApi = getElectronSystemPreferences(),
}: {
	systemPreferencesApi?: Pick<
		SystemPreferencesApi,
		"isTrustedAccessibilityClient"
	>;
} = {}): boolean {
	return systemPreferencesApi?.isTrustedAccessibilityClient(false) ?? false;
}

export function getPermissionStatus() {
	return {
		fullDiskAccess: checkFullDiskAccess(),
		accessibility: checkAccessibility(),
	};
}

export async function requestFullDiskAccess({
	shellApi = getElectronShell(),
}: {
	shellApi?: ShellApi;
} = {}): Promise<void> {
	await shellApi.openExternal(PERMISSION_SETTINGS_URLS.fullDiskAccess);
}

export async function requestAccessibility({
	shellApi = getElectronShell(),
}: {
	shellApi?: ShellApi;
} = {}): Promise<void> {
	await shellApi.openExternal(PERMISSION_SETTINGS_URLS.accessibility);
}

export async function requestAppleEvents({
	shellApi = getElectronShell(),
}: {
	shellApi?: ShellApi;
} = {}): Promise<void> {
	await shellApi.openExternal(PERMISSION_SETTINGS_URLS.appleEvents);
}
