import { describe, expect, test } from "bun:test";
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

	test("rejects YAML that does not parse", () => {
		expect(() => fromCompose("services: [")).toThrow(Skip);
	});
});
