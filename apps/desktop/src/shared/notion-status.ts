/** Statuses that mean "no longer waiting on me" - sunk, or left out. */
export const isDoneish = (status: string) =>
	/done|complete|closed|reject|cancel|archiv|ship|fixed|won't|duplicate|can't reproduce/i.test(
		status,
	);
