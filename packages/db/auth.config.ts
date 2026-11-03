// Schema-generation config only: `bun run auth:generate` reads it to emit src/schema/auth.ts.
// The runtime auth instance in apps/server must use the same plugin list and options.
import { apiKey } from "@better-auth/api-key";
import { passkey } from "@better-auth/passkey";
import { sso } from "@better-auth/sso";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, organization, twoFactor } from "better-auth/plugins";

export const auth = betterAuth({
	database: drizzleAdapter({}, { provider: "pg" }),
	user: {
		additionalFields: {
			kind: {
				type: ["human", "machine"],
				required: true,
				defaultValue: "human",
				input: false,
			},
		},
	},
	plugins: [
		organization({
			teams: { enabled: false },
			dynamicAccessControl: { enabled: true },
		}),
		twoFactor(),
		passkey(),
		apiKey(),
		sso(),
		admin(),
	],
});
