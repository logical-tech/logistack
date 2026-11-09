import { createFileRoute } from "@tanstack/react-router";
import { Page, PageHeader } from "@/components/page-header";
import { InstanceMailOverview } from "@/components/work/settings/instance-mail";

export const Route = createFileRoute("/_app/settings/instance-mail")({
	staticData: { crumb: "Instance mail" },
	component: () => (
		<Page>
			<PageHeader
				title="Instance mail"
				description="One SMTP server or Resend account for this whole instance. LogiStack uses it for task notifications, daily digests and invitations."
			/>
			<InstanceMailOverview />
		</Page>
	),
});
