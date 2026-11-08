import { defineManifest } from "@logistack/plugin-sdk";

export const manifest = defineManifest({
	id: "dev.logistack.deploy-notifier",
	version: "0.1.0",
	name: "Deploy alerts",
	description:
		"Posts failed deployments to any chat webhook that takes a JSON `text` field, and lists them.",
	author: { name: "LogiStack", url: "https://stack.logicaltech.it" },
	license: "MIT",
	port: 8080,
	resources: { memory: "96Mi", cpu: 0.1 },
	permissions: ["read"],
	config: {
		type: "object",
		properties: {
			webhookUrl: {
				type: "string",
				title: "Webhook URL",
				description:
					'Receives a POST with `{ "text": … }` for each failed deploy.',
				format: "uri",
				secret: true,
			},
			mention: {
				type: "string",
				title: "Mention",
				description: "Prepended to each message, as @oncall.",
			},
			includeSucceeded: {
				type: "boolean",
				title: "Also post successful deploys",
				default: false,
			},
		},
		required: ["webhookUrl"],
	},
	contributes: {
		events: ["deployment.failed", "deployment.succeeded"],
		pages: [
			{
				id: "failures",
				title: "Deploy alerts",
				icon: "bell",
				location: "sidebar",
				path: "/ui/failures",
			},
			{
				id: "service",
				title: "Alerts",
				location: "service-tab",
				path: "/ui/service",
			},
		],
	},
});
