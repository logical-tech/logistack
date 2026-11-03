/**
 * End-to-end run on the real stack: throwaway Postgres and Redis containers, the API
 * server, Vite with VITE_API_MOCK=0 and headless Chrome. Walks the first-run setup
 * (sslip.io quick start), folders, a project and an image service, then signs out and
 * back in, saving a light 1440 px screenshot per step in docs/screenshots/e2e/.
 *
 *   bun apps/web/scripts/e2e.ts
 *
 * Containers are named ls-test-integ-<run>-* with label logistack.test=integ and are
 * removed by exact name at the end. Needs Docker, Chrome, and network access to Docker Hub.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
	capture,
	clickText,
	connect,
	fill,
	launchChrome,
	type Page,
	sleep,
	submit,
	waitFor,
} from "./cdp";

const ROOT = join(import.meta.dir, "..", "..", "..");
const OUT = join(import.meta.dir, "..", "docs", "screenshots", "e2e");
const VIEWPORT = { width: 1440, height: 900 };
const CHROME_PORT = 9334;
const OWNER = {
	name: "Ada Owner",
	email: "ada@example.com",
	password: "correct horse battery",
};

function docker(...args: string[]) {
	const p = Bun.spawnSync(["docker", ...args], { stderr: "pipe" });
	if (p.exitCode !== 0)
		throw new Error(`docker ${args[0]} failed: ${p.stderr.toString()}`);
	return p.stdout.toString().trim();
}

/** A port the OS just handed out, so parallel runs don't collide. */
function freePort() {
	const server = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: { data() {} },
	});
	const { port } = server;
	server.stop(true);
	return port;
}

async function until(what: string, check: () => Promise<boolean>) {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		if (await check().catch(() => false)) return;
		await sleep(250);
	}
	throw new Error(`${what} did not come up`);
}

/** Real mouse events at the element's centre, for Radix menus that ignore `.click()`. */
async function press(page: Page, selector: string, text = "") {
	const box = (await page.eval(`(() => {
		const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.includes(${JSON.stringify(text)}));
		if (!el) return null;
		const r = el.getBoundingClientRect();
		return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
	})()`)) as { x: number; y: number } | null;
	if (!box) throw new Error(`nothing to press: ${selector} ${text}`);
	for (const type of ["mousePressed", "mouseReleased"])
		await page.send("Input.dispatchMouseEvent", {
			type,
			...box,
			button: "left",
			clickCount: 1,
		});
}

const hasText = (text: string) =>
	`document.body.innerText.includes(${JSON.stringify(text)})`;

async function main() {
	const run = `ls-test-integ-${crypto.randomUUID().slice(0, 8)}`;
	const containers = [`${run}-pg`, `${run}-redis`];
	const procs: ReturnType<typeof Bun.spawn>[] = [];
	let chrome: { close(): Promise<void> } | undefined;
	try {
		const start = (
			name: string,
			image: string,
			port: number,
			env: string[],
		) => {
			docker(
				"run",
				"-d",
				"--name",
				name,
				"--label",
				"logistack.test=integ",
				"-p",
				`127.0.0.1::${port}`,
				...env.flatMap((e) => ["-e", e]),
				image,
			);
			return docker("port", name, `${port}/tcp`).split("\n")[0] as string;
		};
		const pg = start(containers[0] as string, "postgres:17-alpine", 5432, [
			"POSTGRES_PASSWORD=integ",
		]);
		const redis = start(containers[1] as string, "redis:7-alpine", 6379, []);
		await until("postgres", async () =>
			docker(
				"exec",
				containers[0] as string,
				"pg_isready",
				"-U",
				"postgres",
			).includes("accepting"),
		);

		const apiPort = freePort();
		const webPort = freePort();
		const web = `http://localhost:${webPort}`;
		const api = `http://localhost:${apiPort}`;
		procs.push(
			Bun.spawn(["bun", "apps/server/src/index.ts"], {
				cwd: ROOT,
				env: {
					...process.env,
					DATABASE_URL: `postgres://postgres:integ@${pg}/postgres`,
					REDIS_URL: `redis://${redis}`,
					LOGISTACK_MASTER_KEY: crypto
						.getRandomValues(new Uint8Array(32))
						.toBase64(),
					BETTER_AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID(),
					BETTER_AUTH_URL: api,
					WEB_ORIGIN: web,
					PORT: String(apiPort),
					// A documentation address, so screenshots never show the machine's real IP.
					PUBLIC_IP: "203.0.113.10",
					LOG_LEVEL: "silent",
				},
				stdout: "inherit",
				stderr: "inherit",
			}),
		);
		await until("server", async () => (await fetch(`${api}/api/health`)).ok);
		procs.push(
			Bun.spawn(["bunx", "vite", "--port", String(webPort), "--strictPort"], {
				cwd: join(ROOT, "apps", "web"),
				env: { ...process.env, VITE_API_MOCK: "0", LOGISTACK_API: api },
				stdout: "ignore",
				stderr: "inherit",
			}),
		);
		await until("vite", async () => (await fetch(web)).ok);

		await mkdir(OUT, { recursive: true });
		chrome = await launchChrome(CHROME_PORT);
		const page = await connect(CHROME_PORT);
		await page.send("Page.enable");
		await page.send("Emulation.setEmulatedMedia", {
			features: [
				{ name: "prefers-color-scheme", value: "light" },
				{ name: "prefers-reduced-motion", value: "reduce" },
			],
		});
		await page.send("Emulation.setDeviceMetricsOverride", {
			...VIEWPORT,
			deviceScaleFactor: 1,
			mobile: false,
		});
		let n = 0;
		const shot = async (name: string) => {
			await sleep(700);
			n += 1;
			const file = join(OUT, `${String(n).padStart(2, "0")}-${name}.png`);
			await capture(page, file, VIEWPORT);
			console.log(`ok  ${name}`);
		};

		await page.send("Page.navigate", { url: `${web}/` });
		await waitFor(page, `!!document.querySelector("#wz-ownerName")`, 15_000);
		await page.eval(`localStorage.setItem("ls-theme", "light"); true`);
		if (!(await page.eval(`location.pathname === "/setup"`)))
			throw new Error("a fresh instance must redirect to /setup");
		await page.eval(fill("#wz-ownerName", OWNER.name));
		await page.eval(fill("#wz-ownerEmail", OWNER.email));
		await page.eval(fill("#wz-ownerPassword", OWNER.password));
		await shot("setup-owner");
		await page.eval(submit);
		await waitFor(page, `!!document.querySelector("#wz-orgName")`);
		await page.eval(fill("#wz-orgName", "Logical"));
		await page.eval(submit);
		await waitFor(page, `!!document.querySelector("#wz-wildcard")`);
		await page.eval(clickText('[role="radio"]', "sslip.io"));
		await waitFor(page, hasText("203-0-113-10.sslip.io"));
		await shot("setup-domain-sslip");
		await page.eval(submit);
		await waitFor(page, `!!document.querySelector("#wz-leEmail")`);
		await page.eval(fill("#wz-leEmail", "ops@example.com"));
		await page.eval(submit);
		await waitFor(page, `location.search.includes("step=registry")`);
		await page.eval(submit);
		await waitFor(page, hasText("Finish setup"));
		await shot("setup-review");
		await page.eval(submit);
		await waitFor(
			page,
			`location.pathname === "/" && ${hasText("services across")}`,
			15_000,
		);
		await shot("home-signed-in");

		await page.send("Page.navigate", { url: `${web}/projects?create=folder` });
		await waitFor(page, `!!document.querySelector("#folder-name")`);
		await page.eval(fill("#folder-name", "Clients"));
		await page.eval(submit);
		await waitFor(page, hasText(`Folder “Clients” created`));
		await shot("folder-created");

		await page.eval(clickText('nav[aria-label="Folders"] a', "Clients"));
		await waitFor(page, `location.search.includes("folder=fld_")`);
		await page.eval(clickText("button", "New folder"));
		await waitFor(page, `!!document.querySelector("#folder-name")`);
		await page.eval(fill("#folder-name", "Acme Retail"));
		await page.eval(submit);
		await waitFor(page, hasText(`Folder “Acme Retail” created`));
		await shot("subfolder-created");

		await page.eval(clickText('nav[aria-label="Folders"] a', "Acme Retail"));
		await waitFor(
			page,
			`document.querySelector("input[type=search]")?.placeholder.includes("Acme Retail")`,
		);
		await page.eval(clickText("button", "New project"));
		await waitFor(page, `!!document.querySelector("#project-name")`);
		if (
			!(await page.eval(
				`document.querySelector("#project-folder").textContent.includes("Acme Retail")`,
			))
		)
			throw new Error("the new project dialog should preselect Acme Retail");
		await page.eval(fill("#project-name", "Storefront"));
		await page.eval(fill("#project-description", "Customer-facing shop"));
		await page.eval(submit);
		await waitFor(page, hasText("Nothing runs in Production yet"));
		await shot("project-created");

		await page.eval(clickText("a", "New service"));
		await waitFor(page, `!!document.querySelector('[role="radio"]')`);
		await page.eval(clickText('[role="radio"]', "Docker image"));
		await page.eval(submit);
		await waitFor(page, `!!document.querySelector("#wz-image")`);
		await page.eval(fill("#wz-image", "nginx:alpine"));
		await page.eval(submit);
		await waitFor(page, hasText("Test connection"));
		await page.eval(clickText("button", "Test connection"));
		await waitFor(page, hasText("Image found"), 20_000);
		await shot("new-service-image-found");
		await page.eval(submit);
		await waitFor(page, `location.search.includes("step=domain")`);
		// The step slides in; a submit during the transition lands on the outgoing form.
		await sleep(500);
		await page.eval(submit);
		await waitFor(page, hasText("Create and deploy"));
		await shot("new-service-review");
		await page.eval(submit);
		await waitFor(
			page,
			`${hasText("Queued")} && ${hasText("nginx:alpine")}`,
			15_000,
		);
		const listed = (await page.eval(`(async () => {
			const env = new URLSearchParams(location.search).get("env");
			const res = await fetch("/api/environments/" + env + "/services");
			return res.json();
		})()`)) as {
			latestDeployment: { status: string } | null;
			domains: string[];
		}[];
		if (listed[0]?.latestDeployment?.status !== "queued")
			throw new Error(
				`expected a queued deployment, got ${JSON.stringify(listed)}`,
			);
		if (!listed[0]?.domains[0]?.endsWith(".203-0-113-10.sslip.io"))
			throw new Error(
				`expected a generated sslip.io hostname, got ${listed[0]?.domains}`,
			);
		await shot("service-queued");

		await press(page, 'button[aria-label="Account"]');
		await waitFor(page, `!!document.querySelector('[role="menuitem"]')`);
		await page.eval(clickText('[role="menuitem"]', "Sign out"));
		await waitFor(page, `location.pathname === "/sign-in"`);
		await shot("signed-out");

		await page.eval(fill("#email", OWNER.email));
		await page.eval(fill("#password", OWNER.password));
		await page.eval(submit);
		await waitFor(
			page,
			`location.pathname === "/" && ${hasText("Storefront")}`,
			15_000,
		);
		await shot("signed-in-again");
		console.log(`e2e passed; screenshots in ${OUT}`);
	} finally {
		await chrome?.close();
		for (const p of procs) p.kill();
		await Promise.all(procs.map((p) => p.exited));
		for (const name of containers)
			Bun.spawnSync(["docker", "rm", "-f", "-v", name], {
				stdout: "ignore",
				stderr: "ignore",
			});
	}
}

await main();
