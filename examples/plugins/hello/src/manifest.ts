import { defineManifest } from "@logistack/plugin-sdk";

export const manifest = defineManifest({
	id: "dev.logistack.hello",
	version: "1.0.0",
	name: "Hello",
	description:
		"A friendly test plugin: a sidebar page that greets you, counts your hellos and says hi to the Agent.",
	author: { name: "LogiStack", url: "https://stack.logicaltech.it" },
	license: "MIT",
	logistack: ">=0.6.0",
	port: 8080,
	resources: { memory: "64Mi", cpu: 0.05 },
	permissions: [],
	egress: [],
	config: {
		type: "object",
		properties: {
			greeting: {
				type: "string",
				title: "Greeting",
				description: "The word the page greets you with.",
				default: "Hello",
				maxLength: 40,
			},
		},
	},
	contributes: {
		pages: [
			{
				id: "hello",
				title: "Hello",
				icon: "sparkles",
				location: "sidebar",
				path: "/ui/hello",
			},
		],
		tools: [
			{
				name: "say-hello",
				description:
					"Greets someone by name. A harmless tool for trying plugins in the Agent.",
				inputSchema: {
					type: "object",
					properties: { name: { type: "string", minLength: 1, maxLength: 80 } },
					required: ["name"],
				},
				destructive: false,
			},
		],
	},
});
