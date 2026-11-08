import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useCallback } from "react";
import { z } from "zod";
import {
	DatabaseOperations,
	type OperationsWizard,
} from "@/components/database/operations";
import {
	PortForwardWizard,
	PublicAccessWizard,
	UpgradeWizard,
} from "@/components/database/operations-wizards";
import { Button } from "@/components/ui/button";
import { overviewQuery } from "@/lib/api/service-ops";
import { stepParam } from "@/lib/search";

export const Route = createFileRoute(
	"/_app/projects/$projectId/services/$serviceId/operations",
)({
	validateSearch: z.object({
		/** The wizard that is open, at `step`. */
		wizard: z
			.enum(["public", "forward", "upgrade"])
			.optional()
			.catch(undefined),
		step: stepParam,
	}),
	component: OperationsTab,
});

const TITLE: Record<OperationsWizard, string> = {
	public: "Public access for",
	forward: "Port forward to",
	upgrade: "Upgrade",
};

function OperationsTab() {
	const { serviceId } = Route.useParams();
	const { wizard, step } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: service } = useQuery(overviewQuery(serviceId));
	const open = useCallback(
		(w: OperationsWizard) => navigate({ search: { wizard: w } }),
		[navigate],
	);
	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: (s) => ({ ...s, step: id }), replace }),
		[navigate],
	);
	const close = useCallback(() => navigate({ search: {} }), [navigate]);
	if (service?.spec.kind !== "database") return null;
	if (!wizard) return <DatabaseOperations service={service} onWizard={open} />;
	const nav = {
		serviceId,
		engine: service.spec.engine,
		step,
		onStepChange,
		onDone: close,
	};
	return (
		<section
			aria-label={`${TITLE[wizard]} ${service.name}`}
			className="rounded-xl bg-card p-5 shadow-card ring-1 ring-border sm:p-8"
		>
			<div className="mb-8 flex items-center gap-3">
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Back to operations"
					onClick={close}
				>
					<ArrowLeft />
				</Button>
				<h2 className="text-base font-semibold text-balance">
					{TITLE[wizard]} {service.name}
				</h2>
			</div>
			{wizard === "public" && <PublicAccessWizard {...nav} />}
			{wizard === "forward" && <PortForwardWizard {...nav} />}
			{wizard === "upgrade" && (
				<UpgradeWizard {...nav} from={service.spec.version} />
			)}
		</section>
	);
}
