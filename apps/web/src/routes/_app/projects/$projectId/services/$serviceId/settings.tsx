import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useCallback } from "react";
import { z } from "zod";
import { AutoscaleWizard } from "@/components/service/scaling";
import { SettingsForm } from "@/components/service/settings-form";
import { Button } from "@/components/ui/button";
import { autoscaleQuery } from "@/lib/api/autoscale";
import { overviewQuery } from "@/lib/api/service-ops";
import { stepParam } from "@/lib/search";

export const Route = createFileRoute(
	"/_app/projects/$projectId/services/$serviceId/settings",
)({
	validateSearch: z.object({
		/** The automatic scaling wizard is open, at `step`. */
		scaling: z.literal("setup").optional().catch(undefined),
		step: stepParam,
	}),
	component: SettingsTab,
});

function SettingsTab() {
	const { serviceId, projectId } = Route.useParams();
	const { scaling, step } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: service } = useQuery(overviewQuery(serviceId));
	const { data: autoscale } = useQuery({
		...autoscaleQuery(serviceId),
		enabled: scaling === "setup",
	});
	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: { scaling: "setup", step: id }, replace }),
		[navigate],
	);
	const close = useCallback(
		() => navigate({ search: {}, hash: "scaling" }),
		[navigate],
	);
	if (!service) return null;
	if (scaling === "setup" && service.spec.kind === "application")
		return (
			<section
				aria-label="Automatic scaling"
				className="rounded-xl bg-card p-5 shadow-card ring-1 ring-border sm:p-8"
			>
				<div className="mb-8 flex items-center gap-3">
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="Back to settings"
						onClick={close}
					>
						<ArrowLeft />
					</Button>
					<h2 className="text-base font-semibold">
						Automatic scaling for {service.name}
					</h2>
				</div>
				{autoscale && (
					<AutoscaleWizard
						service={service}
						view={autoscale}
						step={step}
						onStepChange={onStepChange}
						onDone={close}
					/>
				)}
			</section>
		);
	return <SettingsForm service={service} projectId={projectId} />;
}
