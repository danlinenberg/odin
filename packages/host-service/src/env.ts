import { randomBytes } from "node:crypto";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
	server: {
		HOST_SERVICE_SECRET: z
			.string()
			.min(1)
			.default(randomBytes(32).toString("hex")),
		ORGANIZATION_ID: z.string().uuid(),
		HOST_DB_PATH: z.string().min(1),
		HOST_MIGRATIONS_FOLDER: z.string().min(1),
		CORS_ORIGINS: z
			.string()
			.transform((s) => s.split(",").map((o) => o.trim()))
			.optional(),
		PORT: z.coerce.number().int().positive().default(4879),
		HOST: z.string().min(1).default("127.0.0.1"),
	},
	runtimeEnv: process.env,
	emptyStringAsUndefined: true,
});
