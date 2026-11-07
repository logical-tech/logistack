import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

// The Agent used to be a tab of the AI page; old links land on its own page.
export const Route = createFileRoute("/_app/ai/agent")({
	validateSearch: z.object({ c: z.string().optional() }),
	beforeLoad: ({ search }) => {
		throw redirect({ to: "/agent", search, replace: true });
	},
});
