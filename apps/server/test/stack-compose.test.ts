import { expect, test } from "bun:test";
import { stackCompose } from "../src/stack-compose.ts";

// Parsed, not snapshotted: Bun's YAML writer formats empty maps differently across patch releases.
test("stackCompose writes desired state and masks secrets", () => {
	const yaml = stackCompose([
		{
			slug: "web",
			spec: {
				kind: "application",
				source: { type: "image", image: "ghcr.io/acme/web:1.2" },
				build: { type: "image" },
				ports: [{ target: 3000, protocol: "tcp" }],
				replicas: 1,
				resources: {},
				placement: [],
			},
			env: [
				{ key: "NODE_ENV", value: "production" },
				{ key: "API_KEY", value: null },
			],
			volumes: [{ name: "uploads", target: "/app/uploads", readOnly: false }],
			domains: ["web.example.com"],
		},
		{
			slug: "db",
			spec: {
				kind: "database",
				engine: "postgres",
				version: "17",
				credentialsRef: "env",
				resources: {},
			},
			env: [{ key: "POSTGRES_PASSWORD", value: null }],
			volumes: [],
			domains: [],
		},
	]);
	expect(Bun.YAML.parse(yaml)).toEqual({
		services: {
			web: {
				image: "ghcr.io/acme/web:1.2",
				ports: ["3000/tcp"],
				environment: { NODE_ENV: "production", API_KEY: "<secret>" },
				volumes: ["uploads:/app/uploads"],
				"x-domains": ["web.example.com"],
			},
			db: {
				image: "postgres:17",
				environment: { POSTGRES_PASSWORD: "<secret>" },
			},
		},
		volumes: { uploads: {} },
	});
});
