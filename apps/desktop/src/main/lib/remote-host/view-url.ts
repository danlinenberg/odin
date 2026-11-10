/** The Screen Sharing link for a tunnelled VNC screen: the password in it, so there is nothing to type. */
export const viewUrl = (port: number, password: string) =>
	`vnc://:${encodeURIComponent(password)}@localhost:${port}`;
