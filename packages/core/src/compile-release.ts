import { LABEL_KIND, type Labels, type ServiceSpec } from "@logistack/docker";

export type ReleasePhase = "pre" | "post";

const ours = (labels: Labels | undefined): Labels =>
	Object.fromEntries(
		Object.entries(labels ?? {}).filter(([k]) => k.startsWith("logistack.")),
	);

/**
 * A one-off Swarm job running `command` with everything the service's tasks get (image, env,
 * networks, secrets, configs, mounts, placement), and nothing that would route traffic to it:
 * no network aliases, no published ports, no proxy labels, no healthcheck.
 */
export function compileRelease(
	svc: ServiceSpec,
	phase: ReleasePhase,
	command: string[],
): ServiceSpec {
	const labels = { ...ours(svc.Labels), [LABEL_KIND]: "release" };
	const { Healthcheck: _, ...container } = svc.TaskTemplate.ContainerSpec;
	return {
		Name: `${svc.Name}-${phase}`,
		Labels: labels,
		TaskTemplate: {
			...svc.TaskTemplate,
			ContainerSpec: {
				...container,
				Labels: { ...ours(container.Labels), [LABEL_KIND]: "release" },
				Args: command,
			},
			RestartPolicy: { Condition: "none" },
			Networks: (svc.TaskTemplate.Networks ?? []).map((n) => ({
				Target: n.Target,
			})),
		},
		Mode: { ReplicatedJob: { MaxConcurrent: 1, TotalCompletions: 1 } },
	};
}
