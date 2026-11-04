import { expect, test } from "bun:test";
import { authForImage, imageRegistry } from "../src/labels.ts";

const auth = {
	username: "u",
	password: "p",
	serveraddress: "registry.logical.it",
};

test("image registry host", () => {
	expect(imageRegistry("postgres:17")).toBe("docker.io");
	expect(imageRegistry("bitnami/redis:7")).toBe("docker.io");
	expect(imageRegistry("ghcr.io/tursodatabase/libsql-server:v0.24.33")).toBe(
		"ghcr.io",
	);
	expect(imageRegistry("localhost:5000/app:1")).toBe("localhost:5000");
});

test("credentials go only to their own registry", () => {
	expect(authForImage("registry.logical.it/org/app:dep_1", auth)).toBe(auth);
	expect(
		authForImage("ghcr.io/tursodatabase/libsql-server:v0.24.33", auth),
	).toBeUndefined();
	expect(authForImage("postgres:17", auth)).toBeUndefined();
	expect(
		authForImage("postgres:17", {
			...auth,
			serveraddress: "https://index.docker.io/v1/",
		}),
	).toBeDefined();
});
