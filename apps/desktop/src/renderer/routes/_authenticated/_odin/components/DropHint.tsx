import { PILL } from "./pill";

/**
 * The Review sweep's DROP verdict on a row, the same red hint on every screen
 * — Review's DROP chip colour — so a board card and Next in line agree.
 */
export function DropHint({ evidence }: { evidence: string }) {
	return (
		<div
			title={`The Review sweep says drop this: ${evidence}`}
			className={`mt-1 line-clamp-2 w-full rounded-[5px] px-[7px] py-px text-[11px] font-medium ${PILL.danger}`}
		>
			Drop? {evidence}
		</div>
	);
}
