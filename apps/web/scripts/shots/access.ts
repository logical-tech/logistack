import type { Page } from "../cdp";
import { shots as account } from "./access-account";
import { shots as keys } from "./access-keys";
import { shots as members } from "./access-members";

export type Shot = {
	name: string;
	path: string;
	/** JS expression that is truthy once the screen is ready. */
	ready: string;
	steps?: (
		page: Page,
		viewport: { width: number; mobile: boolean },
	) => Promise<void>;
};

export const shots: Shot[] = [...members, ...keys, ...account];
