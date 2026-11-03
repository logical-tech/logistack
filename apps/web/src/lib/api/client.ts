import type { AppType } from "@logistack/server";
import { hc } from "hono/client";

/** Typed client over the server's routes; requests go to the page's own origin. */
export const client = hc<AppType>("/", { init: { credentials: "include" } });
