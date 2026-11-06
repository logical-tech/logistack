import { expect, test } from "bun:test";
import { compileRelease } from "../src/compile-release.ts";
import {
	bridgeRouterLabels,
	type CompileServiceInput,
	compileService,
} from "../src/compile-service.ts";

const input: CompileServiceInput = {
	service: {
		id: "svc_app0000000000000000000000",
		organizationId: "org_acme",
		environmentId: "env_prod00000000000000000000",
		slug: "web",
		desiredState: "running",
		spec: {
			kind: "application",
			source: { type: "image", image: "app:1" },
			build: { type: "image" },
			ports: [{ target: 8080, published: 18080, protocol: "tcp" }],
			replicas: 3,
			resources: {},
			command: ["serve"],
			healthcheck: { type: "http", port: 8080, path: "/" },
			placement: ["node.labels.region==eu"],
		},
	},
	deploymentId: "dep_one0000000000000000000000",
	image: "registry.example.com/org_acme/web:dep_one",
	env: { DATABASE_URL: "postgres://db" },
	context: {
		project: "Shop",
		environment: "prod",
		service: "Web",
		domains: [],
	},
	mounts: [],
	domains: [{ port: 8080 }],
	networks: { environment: "net-env", ingress: "net-ingress", bridge: "net-b" },
	bridgeLabels: bridgeRouterLabels(
		"svc_app0000000000000000000000",
		"dokploy-network",
		[
			{
				hostname: "web.example.com",
				port: 8080,
				pathPrefix: null,
				https: true,
			},
		],
		"traefik-swarm",
	),
	bridgeContainerLabels: { "traefik.enable": "true" },
	fileIds: {},
	scope: { namePrefix: "ls-test-x-", labels: { "logistack.test": "x" } },
};

test("a release job runs the new image with the service's env and networks, and takes no traffic", () => {
	const svc = compileService(input);
	const job = compileRelease(svc, "pre", ["bun", "run", "db:migrate"]);
	const c = job.TaskTemplate.ContainerSpec;

	expect(job.Name).toBe(`${svc.Name}-pre`);
	expect(job.Mode).toEqual({
		ReplicatedJob: { MaxConcurrent: 1, TotalCompletions: 1 },
	});
	expect(job.TaskTemplate.RestartPolicy).toEqual({ Condition: "none" });
	expect(c.Image).toBe(input.image as string);
	expect(c.Args).toEqual(["bun", "run", "db:migrate"]);
	expect(c.Env).toEqual(svc.TaskTemplate.ContainerSpec.Env);
	expect(c.Healthcheck).toBeUndefined();
	expect(job.TaskTemplate.Placement).toEqual(svc.TaskTemplate.Placement);
	expect(job.TaskTemplate.Networks).toEqual([
		{ Target: "net-env" },
		{ Target: "net-ingress" },
		{ Target: "net-b" },
	]);
	expect(job.EndpointSpec).toBeUndefined();
	expect(job.UpdateConfig).toBeUndefined();
	for (const labels of [job.Labels, c.Labels]) {
		expect(labels).toMatchObject({
			"logistack.managed": "true",
			"logistack.resource": input.service.id,
			"logistack.kind": "release",
			"logistack.org": "org_acme",
			"logistack.test": "x",
			"logistack.deployment": input.deploymentId,
		});
		expect(
			Object.keys(labels ?? {}).filter((k) => k.startsWith("traefik")),
		).toEqual([]);
	}
});
