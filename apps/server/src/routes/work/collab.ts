import { router } from "../../openapi.ts";
import { workAttachments } from "./attachments.ts";
import { workComments } from "./comments.ts";
import { workInbox } from "./inbox.ts";
import { instanceMail } from "./instance-mail.ts";
import { workPublic } from "./public.ts";

/**
 * Work collaboration: comments, attachments, inbox and preferences, instance mail, and the
 * public calendar feed and unsubscribe links. Paths are absolute; mounted at "/".
 */
export const workCollab = router()
	.route("/", workComments)
	.route("/", workAttachments)
	.route("/", workInbox)
	.route("/", instanceMail)
	.route("/", workPublic);
