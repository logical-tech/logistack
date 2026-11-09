import type { NotificationChannelKind } from "@logistack/contracts";
import type { z } from "zod";
import type { ProviderDef } from "../http.ts";
import { discord } from "./channels/discord.ts";
import { email } from "./channels/email.ts";
import { gotify } from "./channels/gotify.ts";
import { mattermost } from "./channels/mattermost.ts";
import { ntfy } from "./channels/ntfy.ts";
import { pushover } from "./channels/pushover.ts";
import { slack } from "./channels/slack.ts";
import { teams } from "./channels/teams.ts";
import { telegram } from "./channels/telegram.ts";
import { webhook } from "./channels/webhook.ts";
import type { NotificationChannel } from "./types.ts";

export * from "./channels/discord.ts";
export * from "./channels/email.ts";
export * from "./channels/gotify.ts";
export * from "./channels/mattermost.ts";
export * from "./channels/ntfy.ts";
export * from "./channels/pushover.ts";
export * from "./channels/slack.ts";
export * from "./channels/teams.ts";
export * from "./channels/telegram.ts";
export * from "./channels/webhook.ts";
export * from "./mailer.ts";
export * from "./render.ts";
export * from "./rules.ts";
export * from "./types.ts";

/** Every `NotificationChannelKind` in contracts has an implementation. */
export const notificationChannels = {
	email,
	slack,
	discord,
	telegram,
	teams,
	mattermost,
	ntfy,
	gotify,
	pushover,
	webhook,
} satisfies Record<
	Exclude<NotificationChannelKind, "plugin">,
	ProviderDef<z.ZodType, NotificationChannel>
>;
