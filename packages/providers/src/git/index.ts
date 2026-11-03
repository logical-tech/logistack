import type { GitProviderKind } from "@logistack/contracts";
import type { z } from "zod";
import type { ProviderDef } from "../http.ts";
import { bitbucket } from "./bitbucket.ts";
import { generic } from "./generic.ts";
import { gitea } from "./gitea.ts";
import { github } from "./github.ts";
import { gitlab } from "./gitlab.ts";
import type { GitProvider } from "./types.ts";

export * from "./bitbucket.ts";
export * from "./generic.ts";
export * from "./gitea.ts";
export * from "./github.ts";
export * from "./gitlab.ts";
export * from "./types.ts";

/** Every `GitProviderKind` in contracts has an implementation. */
export const gitProviders = {
	github,
	gitlab,
	gitea,
	bitbucket,
	generic,
} satisfies Record<GitProviderKind, ProviderDef<z.ZodType, GitProvider>>;
