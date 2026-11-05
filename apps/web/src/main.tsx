import "./styles/index.css";
import {
	MutationCache,
	QueryCache,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ENROL_PATH, isTwoFactorRequired } from "./lib/two-factor-gate";
import { routeTree } from "./routeTree.gen";

// The organization's two-factor deadline passed mid-session: every API call now fails the same way.
function onApiError(err: unknown) {
	if (!isTwoFactorRequired(err)) return;
	void queryClient.invalidateQueries({ queryKey: ["me"] });
	if (router.state.location.pathname !== ENROL_PATH)
		void router.navigate({ to: ENROL_PATH });
}

const queryClient = new QueryClient({
	queryCache: new QueryCache({ onError: onApiError }),
	mutationCache: new MutationCache({ onError: onApiError }),
	defaultOptions: {
		queries: {
			staleTime: 10_000,
			retry: (count, err) => count < 1 && !isTwoFactorRequired(err),
			refetchOnWindowFocus: true,
		},
	},
});

const router = createRouter({
	routeTree,
	context: { queryClient },
	defaultPreload: "intent",
	defaultPreloadStaleTime: 0,
	scrollRestoration: true,
});

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

const root = document.getElementById("root");
if (!root) throw new Error("#root missing from index.html");

createRoot(root).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<TooltipProvider delayDuration={400}>
				<RouterProvider router={router} />
				<Toaster position="bottom-right" />
			</TooltipProvider>
		</QueryClientProvider>
	</StrictMode>,
);
