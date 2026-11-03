import { expect, test } from "bun:test";
import { withRoutedPort } from "./host-settings";

test("the routed port is added unless a published TCP row already maps it", () => {
	expect(withRoutedPort(80, [])).toEqual([{ target: 80, protocol: "tcp" }]);
	const published = [{ target: 80, published: 8080, protocol: "tcp" as const }];
	expect(withRoutedPort(80, published)).toEqual(published);
});

test("a UDP row on the same number keeps the routed TCP port", () => {
	const udp = [{ target: 34197, published: 34197, protocol: "udp" as const }];
	expect(withRoutedPort(34197, udp)).toEqual([
		{ target: 34197, protocol: "tcp" },
		...udp,
	]);
});
