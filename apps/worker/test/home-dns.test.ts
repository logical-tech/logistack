import { expect, test } from "bun:test";
import { HomeDnsSettings } from "@logistack/contracts";
import { compileHomeDns, settingsHash } from "../src/home-dns.ts";

const input = {
	name: "ls-hdn-abc",
	image: "technitium/dns-server:15.6.2",
	volume: "ls-hdn-abc-data",
	swarmNodeId: "node123",
	adminPassword: "secret-password",
	labels: { "logistack.managed": "true", "logistack.home-dns": "true" },
};

test("Technitium runs once on the chosen node's host network with the password in env only", () => {
	const spec = compileHomeDns(input);
	expect(spec).toMatchSnapshot();
	const task = spec.TaskTemplate;
	expect(task.Networks).toEqual([{ Target: "host" }]);
	expect(task.Placement?.Constraints).toEqual(["node.id==node123"]);
	expect(spec.Mode).toEqual({ Replicated: { Replicas: 1 } });
	expect(task.ContainerSpec?.CapabilityAdd).toEqual(["NET_ADMIN"]);
	expect(task.ContainerSpec?.Args).toBeUndefined();
	expect(task.ContainerSpec?.Image).not.toEndWith(":latest");
	expect(JSON.stringify(spec.Labels)).not.toContain("secret-password");
});

test("the spec hash follows the node and the password, so either change rolls the service", () => {
	const hash = (i: typeof input) =>
		compileHomeDns(i).Labels?.["logistack.spec-hash"];
	expect(hash(input)).toBe(hash({ ...input }));
	expect(hash({ ...input, swarmNodeId: "other" })).not.toBe(hash(input));
	expect(hash({ ...input, adminPassword: "x" })).not.toBe(hash(input));
});

test("settings hash changes with any setting", () => {
	const base = HomeDnsSettings.parse({});
	expect(settingsHash(base)).toBe(settingsHash(HomeDnsSettings.parse({})));
	expect(settingsHash({ ...base, dnssecValidation: false })).not.toBe(
		settingsHash(base),
	);
});
