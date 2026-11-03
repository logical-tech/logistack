import type { ApiAdapter } from "./adapter";
import { httpAdapter } from "./http";

/** VITE_API_MOCK=1 swaps in the in-memory adapter (design work, screenshots); otherwise the real API. */
export const isMock = import.meta.env.VITE_API_MOCK === "1";

/** Production builds drop the mock branch; the fixtures load as their own chunk. */
export const api: ApiAdapter = isMock
	? (await import("./mock")).mockAdapter
	: httpAdapter;

export type * from "./access-types";
export { ApiError } from "./adapter";
export type * from "./types";
