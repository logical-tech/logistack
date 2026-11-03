/**
 * Captures docs/screenshots/service/sso-*: Settings → Authentication, every step of the OIDC
 * and SAML wizards (the OIDC test runs its popup against the mock callback) and the sign-in
 * page with "Continue with SSO", in light and dark at 1440 and 390 px wide.
 *
 *   VITE_API_MOCK=1 bun run dev -- --port 5181 &
 *   bun scripts/screenshots-sso.ts [baseUrl]
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

const BASE = process.argv[2] ?? "http://localhost:5181";
const OUT = join(import.meta.dir, "..", "docs", "screenshots", "service");
const PORT = Number(process.env.CDP_PORT ?? 9351);

const VIEWPORTS = [
	{ name: "1440", width: 1440, height: 900, mobile: false },
	{ name: "390", width: 390, height: 844, mobile: true },
];
const THEMES = ["light", "dark"] as const;

const hasText = (t: string) =>
	`document.body.textContent.includes(${JSON.stringify(t)})`;
const has = (selector: string) =>
	`!!document.querySelector(${JSON.stringify(selector)})`;

/** A click the browser treats as the user's, so `window.open` is allowed. */
async function gestureClick(page: Page, selector: string, text: string) {
	const r = await page.send("Runtime.evaluate", {
		expression: clickText(selector, text),
		userGesture: true,
		awaitPromise: true,
	});
	if (r.exceptionDetails)
		throw new Error(r.exceptionDetails.exception?.description);
}

async function next(page: Page, ready: string) {
	await page.eval(submit);
	await waitFor(page, ready);
}

async function oidcIssuer(page: Page) {
	await waitFor(page, has("#wz-issuer"));
	await page.eval(fill("#wz-issuer", "https://logical.okta.com"));
	await page.eval(clickText("form button", "Discover"));
	await waitFor(page, hasText("Keys (JWKS)"));
}
async function oidcClient(page: Page) {
	await oidcIssuer(page);
	await next(page, has("#wz-clientId"));
	await page.eval(fill("#wz-clientId", "0oa9x2logistack9fA2"));
	await page.eval(fill("#wz-clientSecret", "mock-client-secret"));
	await waitFor(page, hasText("/sso/callback/"));
}
async function oidcAutoJoin(page: Page) {
	await oidcClient(page);
	await next(page, has("#wz-domain"));
}
async function oidcTest(page: Page) {
	await oidcAutoJoin(page);
	await next(page, hasText("Skip the test"));
	await gestureClick(page, "form button", "Test sign-in");
	await waitFor(page, hasText("Sign-in works"), 10_000);
}
async function samlMetadata(page: Page) {
	await waitFor(page, hasText("Entity ID"));
	await next(page, has("#wz-metadataUrl"));
	await page.eval(
		fill(
			"#wz-metadataUrl",
			"https://login.microsoftonline.com/acme/federationmetadata.xml",
		),
	);
}

type Shot = {
	name: string;
	path: string;
	ready: string;
	signedIn?: boolean;
	steps?: (p: Page) => Promise<void>;
};

const SHOTS: Shot[] = [
	{
		name: "sso-providers",
		path: "/settings/authentication",
		ready: hasText("logical.okta.com"),
	},
	{
		name: "sso-oidc-1-issuer",
		path: "/settings/authentication/oidc",
		ready: "true",
		steps: oidcIssuer,
	},
	{
		name: "sso-oidc-2-client",
		path: "/settings/authentication/oidc",
		ready: "true",
		steps: oidcClient,
	},
	{
		name: "sso-oidc-3-auto-join",
		path: "/settings/authentication/oidc",
		ready: "true",
		steps: oidcAutoJoin,
	},
	{
		name: "sso-oidc-4-test",
		path: "/settings/authentication/oidc",
		ready: "true",
		steps: oidcTest,
	},
	{
		name: "sso-oidc-4-test-skipped",
		path: "/settings/authentication/oidc",
		ready: "true",
		steps: async (page) => {
			await oidcAutoJoin(page);
			await next(page, hasText("Skip the test"));
			await page.eval(clickText("form button", "Skip the test"));
			await waitFor(page, hasText("Saving without a tested sign-in"));
		},
	},
	{
		name: "sso-oidc-5-review",
		path: "/settings/authentication/oidc",
		ready: "true",
		steps: async (page) => {
			await oidcTest(page);
			await next(page, hasText("Sign-in test"));
		},
	},
	{
		name: "sso-saml-1-service-provider",
		path: "/settings/authentication/saml",
		ready: hasText("Entity ID"),
	},
	{
		name: "sso-saml-2-metadata",
		path: "/settings/authentication/saml",
		ready: "true",
		steps: samlMetadata,
	},
	{
		name: "sso-saml-3-auto-join",
		path: "/settings/authentication/saml",
		ready: "true",
		steps: async (page) => {
			await samlMetadata(page);
			await next(page, has("#wz-domain"));
		},
	},
	{
		name: "sso-saml-4-review",
		path: "/settings/authentication/saml",
		ready: "true",
		steps: async (page) => {
			await samlMetadata(page);
			await next(page, has("#wz-domain"));
			await next(page, hasText("checks the metadata"));
		},
	},
	{
		name: "sso-sign-in",
		path: "/sign-in",
		ready: hasText("Continue with SSO"),
		signedIn: false,
	},
	{
		name: "sso-sign-in-email",
		path: "/sign-in",
		ready: hasText("Continue with SSO"),
		signedIn: false,
		steps: async (page) => {
			await page.eval(clickText("button", "Continue with SSO"));
			await waitFor(page, has("#sso-email"));
			await page.eval(fill("#sso-email", "simone@logical.it"));
		},
	},
];

const only = process.env.ONLY?.split(",");

async function main() {
	await mkdir(OUT, { recursive: true });
	const chrome = await launchChrome(PORT);
	try {
		for (const theme of THEMES) {
			for (const vp of VIEWPORTS) {
				const page = await connect(PORT);
				await page.send("Page.enable");
				await page.send("Emulation.setEmulatedMedia", {
					features: [
						{ name: "prefers-color-scheme", value: theme },
						{ name: "prefers-reduced-motion", value: "reduce" },
					],
				});
				for (const shot of SHOTS) {
					if (only && !only.includes(shot.name)) continue;
					await page.send("Emulation.setDeviceMetricsOverride", {
						width: vp.width,
						height: vp.height,
						deviceScaleFactor: vp.mobile ? 2 : 1,
						mobile: vp.mobile,
					});
					await page.send("Page.navigate", { url: `${BASE}/sign-in` });
					await sleep(400);
					const signedIn = shot.signedIn === false ? "0" : "1";
					await page.eval(
						`localStorage.setItem("ls-theme", "${theme}"); localStorage.setItem("ls-mock-signed-in", "${signedIn}"); sessionStorage.clear(); true`,
					);
					await page.send("Page.navigate", { url: `${BASE}${shot.path}` });
					await waitFor(page, shot.ready, 10_000);
					await shot.steps?.(page);
					await sleep(900);
					const file = join(OUT, `${shot.name}-${theme}-${vp.name}.png`);
					await capture(page, file, vp);
					console.log(`saved ${file}`);
				}
			}
		}
	} finally {
		await chrome.close();
	}
}

await main();
