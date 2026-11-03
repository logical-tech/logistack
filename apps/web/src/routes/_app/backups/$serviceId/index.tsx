import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { ApiError } from "@/lib/api";
import { overviewQuery } from "@/lib/api/service-ops";
import type { ServiceId } from "@/lib/api/types";

// Backups live in the service page's Backups tab; the new-policy and restore flows link back here.
export const Route = createFileRoute("/_app/backups/$serviceId/")({
	loader: async ({ context, params }) => {
		const serviceId = params.serviceId as ServiceId;
		try {
			const s = await context.queryClient.ensureQueryData(
				overviewQuery(serviceId),
			);
			throw redirect({
				to: "/projects/$projectId/services/$serviceId/backups",
				params: { projectId: s.projectId as `prj_${string}`, serviceId },
				replace: true,
			});
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) throw notFound();
			throw e;
		}
	},
});
