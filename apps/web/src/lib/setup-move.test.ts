import { describe, expect, test } from "bun:test";
import { diagnose, lanAddress } from "./setup-move";

describe("lanAddress", () => {
	test.each([
		["192-168-1-39.sslip.io", "192.168.1.39"],
		["10.0.0.5.nip.io", "10.0.0.5"],
		["172.20.1.2", "172.20.1.2"],
		["100.100.1.1", "100.100.1.1"],
		["81-57-58-142.sslip.io", null],
		["172.32.0.1", null],
		["localhost", null],
		["127.0.0.1", null],
		["logistack.example.com", null],
		["192-168-1-300.sslip.io", null],
	])("%p -> %p", (host, ip) => {
		expect(lanAddress(host)).toBe(ip);
	});
});

describe("diagnose", () => {
	const lan = "192-168-1-39.sslip.io";

	test("the name at the router's public IP, seen from the LAN, is the NAT case", () => {
		expect(
			diagnose({
				resolvesTo: ["81.57.58.142"],
				publicIp: "81.57.58.142",
				browserHostname: lan,
			}),
		).toEqual({ kind: "nat", publicIp: "81.57.58.142", lanIp: "192.168.1.39" });
	});

	test("no answer means the name does not resolve, wherever the browser is", () => {
		expect(
			diagnose({
				resolvesTo: [],
				publicIp: "81.57.58.142",
				browserHostname: lan,
			}),
		).toEqual({ kind: "unresolved" });
	});

	test("from outside the LAN, or at another address, it is just silent", () => {
		expect(
			diagnose({
				resolvesTo: ["81.57.58.142"],
				publicIp: "81.57.58.142",
				browserHostname: "81-57-58-142.sslip.io",
			}),
		).toEqual({ kind: "silent", addresses: ["81.57.58.142"] });
		expect(
			diagnose({
				resolvesTo: ["203.0.113.9"],
				publicIp: "81.57.58.142",
				browserHostname: lan,
			}),
		).toEqual({ kind: "silent", addresses: ["203.0.113.9"] });
		expect(
			diagnose({
				resolvesTo: ["81.57.58.142"],
				publicIp: null,
				browserHostname: lan,
			}),
		).toEqual({ kind: "silent", addresses: ["81.57.58.142"] });
	});
});
