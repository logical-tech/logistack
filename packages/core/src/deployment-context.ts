import type { DeploymentContextVar } from "@logistack/contracts";

/** Pure: the variable that carries a preview service's URL, such as `LOGISTACK_PREVIEW_URL_API_V2` for `api-v2`. */
export const previewUrlKey = (slug: string) =>
	`LOGISTACK_PREVIEW_URL_${slug.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}` as const;

/** What a deployment knows about itself, from its row, its service and the service's domains. */
export type DeploymentContext = {
	deploymentId: string;
	/** Absent for image sources: nothing was cloned. */
	commit?: { sha: string; message: string | null; branch?: string };
	environment: string;
	project: string;
	service: string;
	/** In creation order. The primary domain is the first serving one, a custom one before a generated one. */
	domains: readonly {
		hostname: string;
		https: boolean;
		/** Plain HTTP to us, but Cloudflare serves it over https. */
		tunnel: boolean;
		pathPrefix: string | null;
		redirectTo: string | null;
		isGenerated: boolean;
	}[];
	/** Set in a pull request preview: every exposed service's URL by slug, and the main one. */
	preview?: { primaryUrl?: string; serviceUrls: Record<string, string> };
};

const MESSAGE_MAX = 200;

/** Pure: the `LOGISTACK_*` variables of a deployment. Unknown values are left unset, never empty. */
export function deploymentContextEnv(
	ctx: DeploymentContext,
): Partial<Record<DeploymentContextVar, string>> & Record<string, string> {
	// A redirecting domain sends visitors elsewhere, so it is not where the app is reached.
	const serving = ctx.domains.filter((d) => !d.redirectTo);
	const hostnames = [...new Set(serving.map((d) => d.hostname))];
	const addressable = serving.filter((d) => !d.hostname.startsWith("*."));
	const primary = addressable.find((d) => !d.isGenerated) ?? addressable[0];
	const message = ctx.commit?.message?.split("\n", 1)[0]?.trim();
	return {
		LOGISTACK_DEPLOYMENT_ID: ctx.deploymentId,
		...(ctx.commit && {
			LOGISTACK_COMMIT_SHA: ctx.commit.sha,
			...(message && {
				LOGISTACK_COMMIT_MESSAGE: message.slice(0, MESSAGE_MAX),
			}),
			...(ctx.commit.branch && { LOGISTACK_BRANCH: ctx.commit.branch }),
		}),
		LOGISTACK_ENVIRONMENT: ctx.environment,
		LOGISTACK_PROJECT: ctx.project,
		LOGISTACK_SERVICE: ctx.service,
		...(primary && {
			LOGISTACK_URL: `${primary.https || primary.tunnel ? "https" : "http"}://${primary.hostname}${primary.pathPrefix ?? ""}`,
		}),
		...(hostnames.length > 0 && { LOGISTACK_FQDN: hostnames.join(",") }),
		...(ctx.preview?.primaryUrl && {
			LOGISTACK_PREVIEW_URL: ctx.preview.primaryUrl,
		}),
		...Object.fromEntries(
			Object.entries(ctx.preview?.serviceUrls ?? {}).map(([slug, url]) => [
				previewUrlKey(slug),
				url,
			]),
		),
	};
}
