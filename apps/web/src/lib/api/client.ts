import type { AppType } from "@logistack/server";
import { hc } from "hono/client";

/** Typed client over the server's routes; requests go to the page's own origin. */
export const client = hc<AppType>("/", { init: { credentials: "include" } });

/** The setup routes' header; omitted when the server needs no setup token. */
export const setupHeader = (token: string) =>
	token ? { "x-setup-token": token } : {};
