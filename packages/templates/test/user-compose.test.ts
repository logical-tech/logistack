import { describe, expect, test } from "bun:test";
import { graceSeconds } from "../src/compose.ts";
import { fromCompose, Skip } from "../src/index.ts";

describe("fromCompose", () => {
	test("maps services, defaults and dependencies", () => {
		const services = fromCompose(`
services:
  web:
    image: ghcr.io/acme/web:1.2
    ports: ["8080"]
    environment:
      DATABASE_URL: postgres://app:\${DB_PASSWORD:-secret}@db:5432/app
      MODE: \${MODE}
    depends_on: [db]
  db:
    image: postgres:17
    environment:
      POSTGRES_PASSWORD: secret
      POSTGRES_USER: app
      POSTGRES_DB: app
    volumes: ["pgdata:/var/lib/postgresql/data"]
volumes:
  pgdata: {}
`);
		expect(services.map((s) => [s.name, s.kind])).toEqual([
			["web", "application"],
			["db", "database"],
		]);
		const web = services[0];
		expect(web?.dependsOn).toEqual(["db"]);
		expect(web?.env).toEqual({
			DATABASE_URL: "postgres://app:secret@${{ services.db.host }}:5432/app",
			MODE: "",
		});
	});

	test("lists every unsupported part", () => {
		const run = () =>
			fromCompose(`
services:
  app:
    build: .
    privileged: true
`);
		expect(run).toThrow(Skip);
		try {
			run();
		} catch (e) {
			expect((e as Skip).reasons.map((r) => r.code).sort()).toEqual(
				["build", "image", "privileged"].sort(),
			);
		}
	});

	test("with a repository, build: is recorded instead of refused", () => {
		const builds = new Map();
		const services = fromCompose(
			`
services:
  api:
    build:
      context: ./api
      dockerfile: docker/Dockerfile
      target: prod
      args:
        VERSION: \${VERSION:-1}
    image: postgres:17
    ports: ["8080"]
  worker:
    build: .
`,
			builds,
		);
		expect(services.map((s) => [s.name, s.kind])).toEqual([
			["api", "application"],
			["worker", "application"],
		]);
		expect(Object.fromEntries(builds)).toEqual({
			api: {
				context: "./api",
				dockerfile: "docker/Dockerfile",
				target: "prod",
				args: { VERSION: "1" },
			},
			worker: { context: ".", dockerfile: "Dockerfile", args: {} },
		});
	});

	test("a remote build context or an unknown build key is refused", () => {
		try {
			fromCompose(
				`
services:
  app:
    build:
      context: https://github.com/acme/app.git
      ssh: [default]
`,
				new Map(),
			);
			throw new Error("expected Skip");
		} catch (e) {
			expect((e as Skip).reasons.map((r) => r.detail)).toEqual([
				"services.app.build.ssh",
				"services.app.build.context https://github.com/acme/app.git",
				"services.app has no image",
			]);
		}
	});

	test("rejects YAML that does not parse", () => {
		expect(() => fromCompose("services: [")).toThrow(Skip);
	});

	test("maps stop_grace_period to drainTimeout in seconds", () => {
		const [app] = fromCompose(`
services:
  app:
    image: ghcr.io/acme/app:1
    stop_grace_period: 1m30s
`);
		expect(app?.kind === "application" && app.drainTimeout).toBe(90);
		expect(graceSeconds("500ms")).toBe(1);
		expect(graceSeconds(20)).toBe(20);
		expect(graceSeconds("2h")).toBe(3600);
		expect(graceSeconds("soon")).toBeUndefined();
	});
});
