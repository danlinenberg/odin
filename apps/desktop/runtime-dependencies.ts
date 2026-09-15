type PackagedNodeModuleCopy = {
	filter: string[];
	from: string;
	to: string;
};

type ExternalizedRuntimeModule = {
	asarUnpackGlobs: string[];
	materialize: string[];
	packagedCopies: PackagedNodeModuleCopy[];
	specifier: string;
};

function copyWholeModule(moduleName: string): PackagedNodeModuleCopy {
	return {
		from: `node_modules/${moduleName}`,
		to: `node_modules/${moduleName}`,
		filter: ["**/*"],
	};
}

function copyModuleSubtree(
	moduleName: string,
	filter: string[],
): PackagedNodeModuleCopy {
	return {
		from: `node_modules/${moduleName}`,
		to: `node_modules/${moduleName}`,
		filter,
	};
}

const externalizedRuntimeModules: ExternalizedRuntimeModule[] = [
	{
		specifier: "better-sqlite3",
		materialize: ["better-sqlite3"],
		packagedCopies: [copyWholeModule("better-sqlite3")],
		asarUnpackGlobs: ["**/node_modules/better-sqlite3/**/*"],
	},
	{
		specifier: "node-pty",
		materialize: ["node-pty"],
		// An explicit copy is its own file set, so the exclusions in
		// electron-builder.ts never reach it — node-pty's Windows prebuilds
		// (24 MB of .pdb debug symbols, OpenConsole.exe and conpty.dll) have to
		// be filtered out right here.
		packagedCopies: [
			copyModuleSubtree("node-pty", [
				"**/*",
				"!prebuilds/{android,freebsd,linux,win32}-*/**",
				"!third_party/**",
			]),
		],
		asarUnpackGlobs: ["**/node_modules/node-pty/**/*"],
	},
	{
		specifier: "native-keymap",
		materialize: ["native-keymap"],
		packagedCopies: [copyWholeModule("native-keymap")],
		asarUnpackGlobs: ["**/node_modules/native-keymap/**/*"],
	},
	{
		specifier: "@odin/macos-process-metrics",
		materialize: ["@odin/macos-process-metrics"],
		packagedCopies: [copyWholeModule("@odin/macos-process-metrics")],
		asarUnpackGlobs: ["**/node_modules/@odin/macos-process-metrics/**/*"],
	},
	{
		specifier: "@ast-grep/napi",
		materialize: ["@ast-grep/napi"],
		packagedCopies: [copyWholeModule("@ast-grep")],
		asarUnpackGlobs: ["**/node_modules/@ast-grep/napi*/**/*"],
	},
	{
		specifier: "@parcel/watcher",
		materialize: ["@parcel/watcher"],
		packagedCopies: [
			copyModuleSubtree("@parcel", ["watcher/**/*", "watcher-*/**/*"]),
		],
		asarUnpackGlobs: ["**/node_modules/@parcel/watcher*/**/*"],
	},
	{
		specifier: "libsql",
		materialize: ["libsql"],
		packagedCopies: [
			copyWholeModule("libsql"),
			copyWholeModule("@libsql"),
			copyWholeModule("@neon-rs"),
		],
		asarUnpackGlobs: ["**/node_modules/@libsql/**/*"],
	},
	{
		specifier: "@mastra/duckdb",
		materialize: [
			"@mastra/duckdb",
			"@duckdb/node-api",
			"@duckdb/node-bindings",
		],
		packagedCopies: [
			copyWholeModule("@mastra/duckdb"),
			copyWholeModule("@duckdb"),
		],
		asarUnpackGlobs: ["**/node_modules/@duckdb/**/*"],
	},
];

const packagedSupportModules = [
	copyWholeModule("bindings"),
	copyWholeModule("file-uri-to-path"),
	copyWholeModule("detect-libc"),
	copyWholeModule("is-glob"),
	copyWholeModule("is-extglob"),
	copyWholeModule("picomatch"),
	copyWholeModule("node-addon-api"),
];

export const mainExternalizedDependencies = [
	...externalizedRuntimeModules.map((module) => module.specifier),
	"pg-native",
	// mastracode transitively loads @mastra/fastembed → onnxruntime-node, whose
	// native binding is loaded via a dynamic `require` that @rollup/plugin-commonjs
	// can't resolve at bundle time. Externalizing lets Node handle the require at
	// runtime from node_modules. Also keeps the bundle size sane (~20 MB chunk).
	"mastracode",
];

export const packagedNodeModuleCopies = [
	...externalizedRuntimeModules.flatMap((module) => module.packagedCopies),
	...packagedSupportModules,
];

export const packagedAsarUnpackGlobs = [
	...externalizedRuntimeModules.flatMap((module) => module.asarUnpackGlobs),
	"**/node_modules/bindings/**/*",
	"**/node_modules/file-uri-to-path/**/*",
];

export const requiredMaterializedNodeModules = [
	...externalizedRuntimeModules.flatMap((module) => module.materialize),
	"bindings",
	"file-uri-to-path",
	"detect-libc",
	"is-glob",
	"is-extglob",
	"picomatch",
	"node-addon-api",
];
