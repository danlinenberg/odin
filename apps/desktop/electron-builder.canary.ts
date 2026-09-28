/**
 * Electron Builder Configuration - Canary Build
 *
 * Extends the base config with canary-specific overrides for internal testing.
 * Can be installed side-by-side with the stable release.
 *
 * @see https://www.electron.build/configuration/configuration
 */

import type { Configuration } from "electron-builder";
import baseConfig from "./electron-builder";

const productName = "Odin Canary";

const config: Configuration = {
	...baseConfig,
	appId: "com.odin.desktop.canary",
	productName,

	publish: {
		provider: "github",
		owner: "danlinenberg",
		repo: "odin",
		releaseType: "prerelease",
	},

	mac: {
		...baseConfig.mac,
		artifactName: `Odin-Canary-\${version}-\${arch}.\${ext}`,
		extendInfo: {
			...baseConfig.mac?.extendInfo,
			CFBundleName: productName,
			CFBundleDisplayName: productName,
		},
	},
};

export default config;
