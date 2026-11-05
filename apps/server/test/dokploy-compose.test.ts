import { describe, expect, test } from "bun:test";
import {
	type ImportPlan,
	interpolate,
	mapCompose,
	parseDotenv,
	projectNameFromFolder,
} from "../scripts/dokploy-compose.ts";
import { dokployComposes } from "./fixtures/dokploy.ts";

function map(appName: string, opts: { allowSensitive?: boolean } = {}) {
	const f = dokployComposes[appName] as { compose: string; env: string };
	return mapCompose({
		appName,
		compose: Bun.YAML.parse(f.compose),
		dotenv: parseDotenv(f.env),
		...opts,
	});
}

function plan(appName: string, opts: { allowSensitive?: boolean } = {}) {
	const m = map(appName, opts);
	if (m.kind !== "plan") throw new Error(m.unsupported.join("; "));
	return m satisfies ImportPlan;
}

const refused = (compose: string, opts: { allowSensitive?: boolean } = {}) => {
	const m = mapCompose({
		appName: "x-abc123",
		compose: Bun.YAML.parse(compose),
		dotenv: new Map(),
		...opts,
	});
	return m.kind === "refused" ? m.unsupported : [];
};

describe("Dokploy compose to application spec", () => {
	test("image, udp port in host mode, bind mount, literal env", () => {
		const p = plan("factorio-server-o8zeig");
		expect(p.projectName).toBe("factorio-server");
		expect(p.serviceName).toBe("factorio");
		expect(p.importedFrom).toBe("dokploy:factorio-server-o8zeig/factorio");
		expect(p.spec).toEqual({
			kind: "application",
			source: { type: "image", image: "factoriotools/factorio:stable" },
			build: { type: "image" },
			ports: [
				{ target: 34197, published: 34197, protocol: "udp", mode: "host" },
			],
			replicas: 1,
			resources: {},
			placement: [],
			mounts: [
				{ kind: "bind", hostPath: "/srv/factorio", target: "/factorio" },
			],
			restart: "any",
		});
		expect(p.env).toEqual([
			{ key: "UPDATE_MODS_ON_START", value: "true", isSecret: false },
			{ key: "DLC_SPACE_AGE", value: "false", isSecret: false },
		]);
		expect(p.domains).toEqual([]);
		expect(p.warnings).toEqual([]);
	});

	test("user, cap_add, expose, Traefik domain, relative and long-syntax binds, .env secrets; dokploy-network ignored", () => {
		// Dokploy's ../files/ resolves under /etc, a sensitive host path.
		const without = map("panel-k3x9qa");
		expect(without.kind === "refused" && without.unsupported).toEqual([
			'services.panel.volumes sensitive host path "/etc/dokploy/compose/panel-k3x9qa/files/config" (pass --allow-sensitive)',
		]);
		const p = plan("panel-k3x9qa", { allowSensitive: true });
		expect(p.spec.user).toBe("1000:1000");
		expect(p.spec.capAdd).toEqual(["NET_ADMIN"]);
		expect(p.spec.ports).toEqual([{ target: 80, protocol: "tcp" }]);
		expect(p.spec.mounts).toEqual([
			{ kind: "bind", hostPath: "/srv/panel/data", target: "/data" },
			{
				kind: "bind",
				hostPath: "/etc/dokploy/compose/panel-k3x9qa/files/config",
				target: "/config",
				readOnly: true,
				allowSensitiveHostPath: true,
			},
		]);
		expect(p.spec.restart).toBeUndefined();
		expect(p.domains).toEqual([{ hostname: "panel.example.com", port: 80 }]);
		expect(p.env).toEqual([
			{ key: "PANEL_PASSWORD", value: "fake-panel-secret-9f2", isSecret: true },
			{ key: "PANEL_URL", value: "https://panel.example.com", isSecret: true },
			{ key: "PANEL_THEME", value: "dark", isSecret: false },
		]);
	});

	test("long-syntax tcp port, restart always, many env with .env substitution", () => {
		const p = plan("minecraft-p2m7rt");
		expect(p.spec.ports).toEqual([
			{ target: 25565, published: 25565, protocol: "tcp", mode: "host" },
		]);
		expect(p.spec.restart).toBe("any");
		expect(p.spec.mounts).toEqual([
			{ kind: "bind", hostPath: "/srv/minecraft", target: "/data" },
		]);
		expect(p.volumes).toEqual([
			{
				name: "backups",
				target: "/backups",
				volume: "minecraft-p2m7rt_backups",
			},
		]);
		expect(p.env.map((e) => [e.key, e.isSecret])).toEqual([
			["EULA", false],
			["TYPE", false],
			["VERSION", false],
			["MEMORY", false],
			["TZ", false],
			["ENABLE_RCON", false],
			["RCON_PASSWORD", true],
			["OPS", true],
		]);
		expect(p.env.find((e) => e.key === "RCON_PASSWORD")?.value).toBe(
			"fake-rcon-secret-71c",
		);
	});

	test("refuses build, multiple services, odd volumes and unknown keys, naming each", () => {
		expect(
			refused(`services:
  app:
    build: .
    image: x
    healthcheck: { test: ["CMD", "true"] }
    volumes: [ "data:/data", "cache:/cache", "data:/ro:ro", "/srv/a:/a" ]
volumes:
  data: {}
  nfs: { driver: local, driver_opts: { type: nfs } }
`),
		).toEqual([
			"volumes.nfs.driver, driver_opts",
			"services.app.build",
			"services.app.healthcheck",
			'services.app.volumes undeclared volume "cache"',
			'services.app.volumes read-only named volume "data"',
		]);
		expect(
			refused("services:\n  a: { image: x }\n  b: { image: y }\n"),
		).toEqual(["multiple services (a, b)"]);
		expect(
			refused(
				"services:\n  a:\n    image: x\n    networks: [backend]\n    labels: [ com.example=1 ]\n",
			),
		).toEqual(["services.a.networks.backend", "services.a.labels.com.example"]);
	});

	test("compose's implicit default network is ignored like dokploy-network", () => {
		expect(
			refused(
				"services:\n  a:\n    image: x\n    networks: [dokploy-network, default]\nnetworks:\n  dokploy-network: { external: true }\n",
			),
		).toEqual([]);
	});

	test("a sensitive bind needs --allow-sensitive, which sets allowSensitiveHostPath", () => {
		const compose =
			"services:\n  a:\n    image: x\n    volumes: [ /var/run/docker.sock:/var/run/docker.sock ]\n";
		expect(refused(compose)).toEqual([
			'services.a.volumes sensitive host path "/var/run/docker.sock" (pass --allow-sensitive)',
		]);
		const m = mapCompose({
			appName: "x-abc123",
			compose: Bun.YAML.parse(compose),
			dotenv: new Map(),
			allowSensitive: true,
		});
		expect(m.kind === "plan" && m.spec.mounts).toEqual([
			{
				kind: "bind",
				hostPath: "/var/run/docker.sock",
				target: "/var/run/docker.sock",
				allowSensitiveHostPath: true,
			},
		]);
	});

	test("restart, cap names and user are validated", () => {
		expect(
			refused(
				"services:\n  a:\n    image: x\n    user: node\n    restart: sometimes\n    cap_drop: [ CAP_CHOWN, NOPE ]\n",
			),
		).toEqual([
			'services.a.cap_drop "NOPE"',
			'services.a.restart "sometimes"',
			"services.a user: must be uid or uid:gid",
		]);
		const m = mapCompose({
			appName: "x-abc123",
			compose: Bun.YAML.parse(
				"services:\n  a:\n    image: x\n    restart: on-failure:3\n    cap_drop: [ CAP_CHOWN ]\n",
			),
			dotenv: new Map(),
		});
		expect(m.kind === "plan" && [m.spec.restart, m.spec.capDrop]).toEqual([
			"on-failure",
			["CHOWN"],
		]);
	});

	test("interpolation follows compose rules and reports missing variables", () => {
		const env = new Map([
			["A", "1"],
			["EMPTY", ""],
		]);
		expect(
			interpolate(`$A \${A} $$A \${EMPTY:-d} \${EMPTY-d} \${B:+x}`, env),
		).toEqual({ value: "1 1 $A d  ", used: ["A", "A", "EMPTY"], missing: [] });
		expect(interpolate(`\${NOPE}`, env)).toEqual({
			value: "",
			used: [],
			missing: ["NOPE"],
		});
		expect(projectNameFromFolder("factorio-server-o8zeig")).toBe(
			"factorio-server",
		);
		expect(parseDotenv("# c\nexport A=\"x y\"\nB='z'\nC=a=b\n")).toEqual(
			new Map([
				["A", "x y"],
				["B", "z"],
				["C", "a=b"],
			]),
		);
	});

	test("named volumes become adopted volumes under Dokploy's compose project name", () => {
		const m = mapCompose({
			appName: "shop-a1b2c3",
			compose: Bun.YAML.parse(`services:
  app:
    image: nginx:1.27
    volumes:
      - "site_data:/usr/share/nginx/html/"
      - { type: volume, source: logs, target: /var/log/nginx }
      - "uploads:/uploads"
volumes:
  site_data:
  logs: { name: shared-logs }
  uploads: { external: true }
`),
			dotenv: new Map(),
		});
		if (m.kind !== "plan") throw new Error(m.unsupported.join("; "));
		expect(m.volumes).toEqual([
			{
				name: "site-data",
				target: "/usr/share/nginx/html",
				volume: "shop-a1b2c3_site_data",
			},
			{ name: "logs", target: "/var/log/nginx", volume: "shared-logs" },
			{ name: "uploads", target: "/uploads", volume: "uploads" },
		]);
		expect(m.spec.mounts).toBeUndefined();
	});
});
