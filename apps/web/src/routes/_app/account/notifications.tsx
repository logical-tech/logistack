import { createFileRoute } from "@tanstack/react-router";
import { Page, PageHeader } from "@/components/page-header";
import { NotificationPrefs } from "@/components/work/settings/notification-prefs";

export const Route = createFileRoute("/_app/account/notifications")({
	staticData: { crumb: "Notifications" },
	component: () => (
		<Page className="max-w-4xl">
			<PageHeader
				title="Notifications"
				description="Task notifications always land in your inbox. Choose what also comes by email, and subscribe to your due dates in a calendar."
			/>
			<NotificationPrefs />
		</Page>
	),
});
