import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { AgentPage } from "@/components/ai/agent";

export const Route = createFileRoute("/_app/ai/agent")({
	staticData: { crumb: "Agent" },
	// The open conversation is in the URL, so a refresh lands on it again.
	validateSearch: z.object({ c: z.string().optional() }),
	component: Agent,
});

function Agent() {
	const { c } = Route.useSearch();
	return <AgentPage conversationId={c} />;
}
