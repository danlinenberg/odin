import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the phone's uploads land - the folder the desktop composer saves to
 * (system.saveAttachment). An object so a test can point it elsewhere.
 */
export const attachments = { dir: join(homedir(), ".odin", "attachments") };
