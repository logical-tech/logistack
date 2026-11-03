import { describe, expect, test } from "bun:test";
import { gitUrl, parseImageRef } from "../src/probe.ts";

describe("parseImageRef", () => {
	test.each([
		[
			"nginx:alpine",
			{
				registry: "registry-1.docker.io",
				repository: "library/nginx",
				reference: "alpine",
			},
		],
		[
			"nginx",
			{
				registry: "registry-1.docker.io",
				repository: "library/nginx",
				reference: "latest",
			},
		],
		[
			"bitnami/redis:7.4",
			{
				registry: "registry-1.docker.io",
				repository: "bitnami/redis",
				reference: "7.4",
			},
		],
		[
			"ghcr.io/acme/web/api:1.2.3",
			{ registry: "ghcr.io", repository: "acme/web/api", reference: "1.2.3" },
		],
		[
			"localhost:5000/app",
			{ registry: "localhost:5000", repository: "app", reference: "latest" },
		],
		[
			`ghcr.io/acme/web@sha256:${"a".repeat(64)}`,
			{
				registry: "ghcr.io",
				repository: "acme/web",
				reference: `sha256:${"a".repeat(64)}`,
			},
		],
	])("%s", (image, expected) => {
		expect(parseImageRef(image)).toEqual(expected);
	});

	test.each([
		"",
		"Nginx",
		"nginx:",
		"nginx@sha256:short",
		"../etc/passwd",
		"ghcr.io/acme/../x",
	])("rejects %p", (image) => {
		expect(parseImageRef(image)).toBeNull();
	});
});

describe("gitUrl", () => {
	test("adds https to a bare host path", () => {
		expect(gitUrl("github.com/acme/shop")).toBe("https://github.com/acme/shop");
		expect(gitUrl(" https://gitlab.com/a/b.git ")).toBe(
			"https://gitlab.com/a/b.git",
		);
	});

	test.each([
		"http://github.com/a/b",
		"file:///etc",
		"ssh://git@github.com/a/b",
		"ext::sh -c touch% /tmp/pwned",
		"https://user:token@github.com/a/b",
		"https://token@github.com/a/b",
	])("refuses %p", (repository) => {
		expect(gitUrl(repository)).toBeNull();
	});
});
