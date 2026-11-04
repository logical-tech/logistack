import { expect, test } from "bun:test";
import {
	defaultServiceIcon,
	ServiceIcon,
	type ServiceSpec,
} from "../src/index.ts";

const image = (image: string) =>
	({
		kind: "application",
		source: { type: "image", image },
	}) as ServiceSpec;

test("databases and storage default to their engine's icon", () => {
	expect(
		defaultServiceIcon({ kind: "database", engine: "postgres" } as ServiceSpec),
	).toBe("postgresql");
	expect(
		defaultServiceIcon({ kind: "storage", engine: "garage" } as ServiceSpec),
	).toBe("garage");
});

test("images map to a brand by their last path segment", () => {
	expect(defaultServiceIcon(image("nginx:1.27"))).toBe("nginx");
	expect(defaultServiceIcon(image("docker.io/library/postgres:17"))).toBe(
		"postgresql",
	);
	expect(defaultServiceIcon(image("ghcr.io/louislam/uptime-kuma:2"))).toBe(
		"uptimekuma",
	);
	expect(defaultServiceIcon(image("ghcr.io/acme/web@sha256:abc"))).toBeNull();
});

test("the allowlist rejects unknown slugs", () => {
	expect(ServiceIcon.safeParse("postgresql").success).toBe(true);
	expect(ServiceIcon.safeParse("<svg>").success).toBe(false);
});
