/** Invites, RSVPs and cancellations are never a row - the calendar has them. */
export const isCalendarMail = (subject: string) =>
	/^(updated |new event: |canceled event: |cancelled event: )?(invitation|accepted|declined|tentatively accepted|canceled|cancelled)( event)?:/i.test(
		subject.trim(),
	);
