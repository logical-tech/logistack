import { clickText, fill, sleep, waitFor } from "../cdp";
import type { Shot } from "./access";

const auditRows = `document.querySelectorAll('table[aria-label="Audit log"] tbody tr').length > 5`;

export const shots: Shot[] = [
	{
		name: "account-2fa",
		path: "/account/security?step=password",
		ready: `!!document.querySelector("#wz-password")`,
		steps: async (page) => {
			await page.eval(fill("#wz-password", "correct horse battery"));
			await page.eval(clickText("button", "Confirm password"));
			await waitFor(
				page,
				`document.body.textContent.includes("Password confirmed")`,
			);
			await page.eval(
				`document.querySelector("form button[type=submit]").click()`,
			);
			await waitFor(
				page,
				`!!document.querySelector('[aria-label="QR code for your authenticator app"] svg')`,
			);
			await sleep(200);
		},
	},
	{
		name: "audit-log",
		path: "/settings/audit-log",
		ready: auditRows,
	},
	{
		name: "audit-drawer",
		path: "/settings/audit-log?action=service.update",
		ready: auditRows.replace("> 5", "> 0"),
		steps: async (page) => {
			await page.eval(
				`document.querySelector('table[aria-label="Audit log"] tbody tr button').click()`,
			);
			await waitFor(page, `document.body.textContent.includes("Before")`);
		},
	},
];
