import { describe, expect, test } from "bun:test";
import { gamePorts, type PortMapping } from "@logistack/contracts";
import {
	ingressPortHolder,
	type PortHolder,
	publishedPortConflicts,
	suggestGamePort,
} from "../src/ports.ts";

const udp = (published: number, mode?: "host" | "ingress"): PortMapping => ({
	target: published,
	published,
	protocol: "udp",
	...(mode ? { mode } : {}),
});
const holder = (
	id: string,
	nodeId: string | null,
	...ports: PortMapping[]
): PortHolder => ({ id, nodeId, ports });

test("host ports clash on the same node and not across nodes", () => {
	const factorio = holder("a", "n1", udp(34197));
	expect(
		publishedPortConflicts(factorio, [holder("b", "n1", udp(34197))]),
	).toEqual([{ port: 34197, protocol: "udp", holderId: "b" }]);
	expect(
		publishedPortConflicts(factorio, [holder("b", "n2", udp(34197))]),
	).toEqual([]);
});

test("an unpinned or ingress-mode holder clashes on every node", () => {
	const factorio = holder("a", "n1", udp(34197));
	expect(
		publishedPortConflicts(factorio, [holder("b", null, udp(34197))]),
	).toHaveLength(1);
	expect(
		publishedPortConflicts(factorio, [
			holder("b", "n2", udp(34197, "ingress")),
		]),
	).toHaveLength(1);
});

test("other protocols, unpublished ports and the stored self never clash", () => {
	const factorio = holder("a", "n1", udp(34197));
	expect(
		publishedPortConflicts(factorio, [
			holder("b", "n1", { target: 34197, published: 34197, protocol: "tcp" }),
			holder("c", "n1", { target: 34197, protocol: "udp" }),
			holder("a", "n1", udp(34197)),
		]),
	).toEqual([]);
});

test("duplicates inside one service and the ingress ports are conflicts", () => {
	expect(
		publishedPortConflicts(holder("a", "n1", udp(9000), udp(9000)), []),
	).toEqual([{ port: 9000, protocol: "udp", holderId: "a" }]);
	expect(
		publishedPortConflicts(
			holder("a", "n1", { target: 8080, published: 443, protocol: "tcp" }),
			[ingressPortHolder],
		),
	).toEqual([{ port: 443, protocol: "tcp", holderId: "ingress" }]);
});

describe("suggestGamePort", () => {
	const ts = {
		id: "svc_ts",
		nodeId: "n1",
		ports: gamePorts({ game: "teamspeak3" }, 9987),
	};
	test("the default port when the node has it free", () => {
		expect(suggestGamePort({ game: "teamspeak3" }, "n1", [])).toBe(9987);
		expect(suggestGamePort({ game: "teamspeak3" }, "n2", [ts])).toBe(9987);
	});
	test("the next port whose derived ports are free too", () => {
		expect(suggestGamePort({ game: "teamspeak3" }, "n1", [ts])).toBe(9988);
	});
	test("a service does not conflict with itself", () => {
		expect(suggestGamePort({ game: "teamspeak3" }, "n1", [ts], "svc_ts")).toBe(
			9987,
		);
	});
	test("skips a port another service holds", () => {
		const web = {
			id: "svc_web",
			nodeId: "n1",
			ports: [{ target: 80, published: 25565, protocol: "tcp" as const }],
		};
		expect(
			suggestGamePort({ game: "minecraft-java" }, "n1", [
				web,
				ingressPortHolder,
			]),
		).toBe(25566);
	});
});
