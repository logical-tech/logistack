import { ShieldAlert } from "lucide-react";
import { useMe } from "@/lib/api/access";
import { relativeTime } from "@/lib/format";

const longDate = new Intl.DateTimeFormat("en", { dateStyle: "long" });

/** Why someone landed here: their organization requires a second factor they have not added yet. */
export function TwoFactorRequirement() {
	const tf = useMe().data?.twoFactor;
	if (!tf) return null;
	const blocked = tf.kind === "blocked";
	return (
		<div
			role={blocked ? "alert" : "status"}
			className={
				blocked
					? "t-reveal flex items-start gap-3 rounded-lg bg-bad/10 px-4 py-3.5 text-sm text-bad-text"
					: "t-reveal flex items-start gap-3 rounded-lg bg-warn/10 px-4 py-3.5 text-sm text-warn-text"
			}
		>
			<ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
			<div className="grid gap-1">
				<p className="font-medium text-pretty">
					{blocked
						? "Your organization requires two-factor authentication"
						: `Add a second factor by ${longDate.format(new Date(tf.deadline))}`}
				</p>
				<p className="text-pretty text-foreground/80">
					{blocked
						? "Projects and settings stay locked until you add an authenticator app or a passkey below. It takes about a minute."
						: `Your organization requires an authenticator app or a passkey. Access pauses ${relativeTime(tf.deadline)} if you haven't added one by then.`}
				</p>
			</div>
		</div>
	);
}
