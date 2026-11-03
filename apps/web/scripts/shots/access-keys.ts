import { type Page, sleep, submit, waitFor } from "../cdp";
import type { Shot } from "./access";

/** Seeds the wizard's saved answers (as a visitor's earlier steps would) and opens `step`. */
async function openWizardAt(page: Page, step: string) {
	const answers = {
		name: "storefront-ci",
		owner: "me",
		access: "scoped",
		scopes: [
			{ role: "developer", scope: { kind: "folder", id: "fld_clients" } },
		],
		expiry: "90",
	};
	const base = String(await page.eval("location.origin"));
	// Seed from a page without the wizard, so a mounted wizard can't overwrite the answers.
	await page.send("Page.navigate", { url: `${base}/sign-in` });
	await waitFor(page, `location.pathname === "/sign-in"`);
	await page.eval(
		`sessionStorage.setItem("wizard:new-api-key", ${JSON.stringify(JSON.stringify(answers))}); true`,
	);
	await page.send("Page.navigate", {
		url: `${base}/settings/api-keys/new?step=${step}`,
	});
	await waitFor(page, `!!document.querySelector("#wz-step-${step}")`);
	await sleep(300);
}

export const shots: Shot[] = [
	{
		name: "api-keys",
		path: "/settings/api-keys",
		ready: `document.querySelectorAll('table[aria-label="API keys"] tbody tr').length > 2 && !!document.querySelector("#mcp")`,
	},
	{
		name: "api-key-wizard",
		path: "/settings/api-keys/new",
		ready: `!!document.querySelector("#wz-name")`,
		steps: (page) => openWizardAt(page, "access"),
	},
	{
		name: "api-key-created",
		path: "/settings/api-keys/new",
		ready: `!!document.querySelector("#wz-name")`,
		steps: async (page) => {
			await openWizardAt(page, "review");
			await page.eval(submit);
			await waitFor(page, `document.body.textContent.includes("Key created")`);
		},
	},
	{
		name: "ssh-keys",
		path: "/settings/ssh-keys",
		ready: `document.querySelectorAll("#ssh-keys ~ div li, section[aria-labelledby=ssh-keys] li").length > 1`,
	},
];
