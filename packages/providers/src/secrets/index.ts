import type { SecretProviderKind } from "@logistack/contracts";
import type { z } from "zod";
import type { ProviderDef } from "../http.ts";
import { infisical } from "./infisical.ts";
import { onepassword } from "./onepassword.ts";
import type { SecretSource } from "./types.ts";
import { vault } from "./vault.ts";

export type { SecretSource } from "./types.ts";
export { infisical, onepassword, vault };

export const secretProviders = {
	vault,
	infisical,
	onepassword,
} satisfies Record<SecretProviderKind, ProviderDef<z.ZodType, SecretSource>>;
