import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { z } from "zod";
import { Page, PageHeader } from "@/components/page-header";
import { InstanceMailSetup } from "@/components/work/settings/instance-mail";
import { stepParam } from "@/lib/search";

export const Route = createFileRoute("/_app/settings/instance-mail_/setup")({
	staticData: { crumb: "Set up email" },
	validateSearch: z.object({ step: stepParam }),
	component: SetUpMail,
});

function SetUpMail() {
	const { step } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: { step: id }, replace }),
		[navigate],
	);
	return (
		<Page className="max-w-5xl">
			<PageHeader
				title="Set up instance email"
				description="Choose a transport, add its credentials and send a test before anything is saved."
			/>
			<InstanceMailSetup step={step} onStepChange={onStepChange} />
		</Page>
	);
}
