// pidusage ships no types and there is no @types package for v4; this covers
// the one call resource-metrics makes.
declare module "pidusage" {
	interface Status {
		cpu: number;
		memory: number;
		ppid: number;
		pid: number;
		ctime: number;
		elapsed: number;
		timestamp: number;
	}
	export default function pidusage(
		pids: number[],
	): Promise<Record<number, Status | undefined>>;
}
