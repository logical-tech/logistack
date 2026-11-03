import { clickText, waitFor } from "../cdp";
import type { Shot } from "./access";

export const shots: Shot[] = [
	{
		name: "members",
		path: "/settings/members",
		ready: `document.querySelectorAll("#people ~ div li, section[aria-labelledby=people] ul > li").length > 3`,
	},
	{
		name: "roles-editor",
		path: "/settings/roles",
		ready: `[...document.querySelectorAll("button")].some(b => b.getAttribute("aria-label") === "Edit role deployer")`,
		steps: async (page) => {
			await page.eval(
				`document.querySelector('[aria-label="Edit role deployer"]').click()`,
			);
			await waitFor(page, `!!document.querySelector("#role-action-write")`);
			await page.eval(clickText("label", "Write"));
		},
	},
];
