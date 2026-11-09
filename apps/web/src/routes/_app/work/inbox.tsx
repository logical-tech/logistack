import { createFileRoute } from "@tanstack/react-router";
import { InboxList } from "@/components/work/inbox-list";

export const Route = createFileRoute("/_app/work/inbox")({
	staticData: { crumb: "Inbox" },
	component: InboxList,
});
