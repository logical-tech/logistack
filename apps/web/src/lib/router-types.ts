import "@tanstack/react-router";

declare module "@tanstack/react-router" {
	interface StaticDataRouteOption {
		/** Breadcrumb label for this route. Dynamic routes return `crumb` from their loader. */
		crumb?: string;
	}
}
