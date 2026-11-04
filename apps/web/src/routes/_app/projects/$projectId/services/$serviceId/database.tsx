import { RowFilter, RowSort } from "@logistack/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import {
	type DatabaseLocation,
	ServiceDatabase,
} from "@/components/database/service-database";
import { overviewQuery } from "@/lib/api/service-ops";
import { stepParam } from "@/lib/search";

export const Route = createFileRoute(
	"/_app/projects/$projectId/services/$serviceId/database",
)({
	validateSearch: z.object({
		view: z
			.enum(["data", "diagram", "sql", "roles"])
			.optional()
			.catch(undefined),
		database: z.string().max(128).optional().catch(undefined),
		schema: z.string().max(63).optional().catch(undefined),
		table: z.string().max(63).optional().catch(undefined),
		sort: z.array(RowSort).max(8).optional().catch(undefined),
		filter: z.array(RowFilter).max(16).optional().catch(undefined),
		find: z
			.object({
				filter: z.string().max(4000).optional(),
				sort: z.string().max(1000).optional(),
				projection: z.string().max(1000).optional(),
			})
			.optional()
			.catch(undefined),
		match: z.string().max(1024).optional().catch(undefined),
		role: z.string().max(320).optional().catch(undefined),
		newRole: z.boolean().optional().catch(undefined),
		step: stepParam,
	}),
	component: DatabaseTab,
});

function DatabaseTab() {
	const { serviceId } = Route.useParams();
	const search = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: service } = useQuery(overviewQuery(serviceId));
	if (!service) return null;
	const at: DatabaseLocation = {
		view: search.view ?? "data",
		database: search.database,
		schema: search.schema,
		table: search.table,
		sort: search.sort ?? [],
		filter: search.filter ?? [],
		find: search.find ?? {},
		match: search.match ?? "*",
		role: search.role,
		newRole: search.newRole ?? false,
		step: search.step,
	};
	return (
		<ServiceDatabase
			service={service}
			at={at}
			onNavigate={(next, opts) => {
				const to = { ...at, ...next };
				// Empty sort and filter are the defaults, so they stay out of the URL.
				navigate({
					search: {
						view: to.view === "data" ? undefined : to.view,
						database: to.database,
						schema: to.schema,
						table: to.table,
						sort: to.sort.length ? to.sort : undefined,
						filter: to.filter.length ? to.filter : undefined,
						find: Object.values(to.find).some(Boolean) ? to.find : undefined,
						match: to.match === "*" ? undefined : to.match,
						role: to.view === "roles" ? to.role : undefined,
						newRole: to.view === "roles" && to.newRole ? true : undefined,
						step: to.view === "roles" && to.newRole ? to.step : undefined,
					},
					replace:
						opts?.replace ??
						!(
							"table" in next ||
							"view" in next ||
							"database" in next ||
							"newRole" in next
						),
				});
			}}
		/>
	);
}
