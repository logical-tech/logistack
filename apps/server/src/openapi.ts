import { OpenAPIHono, z } from "@hono/zod-openapi";
import {
	ApiError,
	DeploymentStatus,
	DeploymentTrigger,
	DesiredState,
	EnvironmentKind,
	ServiceIcon,
	ServiceKind,
	ServiceSpec,
} from "@logistack/contracts";
import type { Env } from "./env.ts";
import { validationHook } from "./errors.ts";

export const router = () =>
	new OpenAPIHono<Env>({ defaultHook: validationHook });

export const json = <T extends z.ZodType>(schema: T, description: string) => ({
	content: { "application/json": { schema } },
	description,
});

export const body = <T extends z.ZodType>(schema: T) => ({
	body: { content: { "application/json": { schema } }, required: true },
});

const error = (description: string) => json(ApiError, description);

/** Error responses shared by every authenticated route. */
export const errors = {
	400: error("Invalid request"),
	401: error("Not authenticated"),
	403: error("Permission denied"),
	404: error("Not found"),
	409: error("Conflict"),
} as const;

/** A variable name starting with `LOGISTACK_`, reserved for the deployment context. */
export const reservedEnvKey = {
	422: error("Reserved variable name"),
} as const;

export const security: Record<string, string[]>[] = [
	{ session: [] },
	{ apiKey: [] },
];

export const IdParam = z.object({ id: z.string() });

export const Slug = z
	.string()
	.min(1)
	.max(63)
	.regex(
		/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
		"lowercase letters, digits and dashes",
	);

export const Name = z.string().trim().min(1).max(100);

/** Derives a slug from a display name when the client sends none. */
export function slugify(name: string): string {
	const slug = name
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 63)
		.replace(/-+$/, "");
	return slug || "untitled";
}

// Timestamps travel as ISO strings.
const Timestamp = z.string();

export const Folder = z
	.object({
		id: z.string(),
		organizationId: z.string(),
		parentId: z.string().nullable(),
		name: z.string(),
		slug: z.string(),
		position: z.int(),
		createdAt: Timestamp,
		updatedAt: Timestamp,
	})
	.openapi("Folder");

export const Project = z
	.object({
		id: z.string(),
		organizationId: z.string(),
		folderId: z.string().nullable(),
		name: z.string(),
		slug: z.string(),
		description: z.string().nullable(),
		createdAt: Timestamp,
		updatedAt: Timestamp,
	})
	.openapi("Project");

export const Environment = z
	.object({
		id: z.string(),
		projectId: z.string(),
		name: z.string(),
		slug: z.string(),
		kind: EnvironmentKind,
		isDefault: z.boolean(),
		createdAt: Timestamp,
		updatedAt: Timestamp,
	})
	.openapi("Environment");

export const Service = z
	.object({
		id: z.string(),
		environmentId: z.string(),
		name: z.string(),
		slug: z.string(),
		kind: ServiceKind,
		nodeId: z.string().nullable(),
		spec: ServiceSpec,
		desiredState: DesiredState,
		createdBy: z.string().nullable(),
		importedFrom: z.string().nullable(),
		/** Brand icon slug; null shows the engine's or image's default. */
		icon: ServiceIcon.nullable(),
		createdAt: Timestamp,
		updatedAt: Timestamp,
	})
	.openapi("Service");

export const Deployment = z
	.object({
		id: z.string(),
		serviceId: z.string(),
		status: DeploymentStatus,
		trigger: DeploymentTrigger,
		commitSha: z.string().nullable(),
		commitMessage: z.string().nullable(),
		/** The tag a tag or release trigger deploys; null deploys the source branch. */
		gitRef: z.string().nullable(),
		imageRef: z.string().nullable(),
		startedAt: Timestamp.nullable(),
		finishedAt: Timestamp.nullable(),
		error: z.string().nullable(),
		/** Why the deployment is awaiting checks or was skipped. */
		reason: z.string().nullable(),
		logPath: z.string().nullable(),
		supersededBy: z.string().nullable(),
		createdAt: Timestamp,
		updatedAt: Timestamp,
	})
	.openapi("Deployment");

/** PATCH body: every field optional, at least one present. */
export const patchOf = <T extends z.ZodRawShape>(schema: z.ZodObject<T>) =>
	schema
		.partial()
		.refine((o) => Object.keys(o).length > 0, "nothing to update");
