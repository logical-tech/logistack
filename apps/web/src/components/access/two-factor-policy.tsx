import { useState } from "react";
import { toast } from "sonner";
import { isOrgAdmin } from "@/components/access/members-dialogs";
import { Panel, SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { Member, TwoFactorPolicyInput } from "@/lib/api";
import {
	useMe,
	useMembers,
	useSetTwoFactorPolicy,
	useTwoFactorSetting,
} from "@/lib/api/access";

const GRACE_DAYS = [0, 3, 7, 14, 30];

const graceLabel = (d: number) =>
	d === 0 ? "None, lock at once" : `${d} days`;

const hasFactor = (m: Member) => m.twoFactorEnabled || m.passkey;

/** The organization's "require two-factor authentication" setting, saved on every change. */
export function TwoFactorPolicyPanel() {
	const { data: me } = useMe();
	const { data: setting, isPending } = useTwoFactorSetting();
	const { data: members } = useMembers();
	const save = useSetTwoFactorPolicy();
	const [confirming, setConfirming] = useState(false);
	const admin = isOrgAdmin(me);
	const required = setting?.mode === "required";
	const disabled = !admin || !setting || save.isPending;

	const without = members?.filter((m) => !hasFactor(m)) ?? [];
	const selfWithout = without.some((m) => m.userId === me?.userId);

	function apply(change: Partial<TwoFactorPolicyInput>, done: string) {
		if (!setting) return;
		const { enabledAt: _, ...current } = setting;
		save.mutate(
			{ ...current, ...change },
			{
				onSuccess: () => {
					setConfirming(false);
					toast(done);
				},
				onError: (err) =>
					toast.error("Couldn't change the requirement", {
						description: err.message,
					}),
			},
		);
	}

	return (
		<Panel id="two-factor-policy" title="Two-factor authentication">
			{isPending || !setting ? (
				<SkeletonRows rows={1} />
			) : (
				<div className="divide-y">
					<div className="flex items-start justify-between gap-6 p-4">
						<div className="min-w-0">
							<label htmlFor="require-2fa" className="text-sm font-medium">
								Require two-factor authentication
							</label>
							<p
								id="require-2fa-msg"
								className="mt-1 max-w-[60ch] text-sm text-pretty text-muted-foreground"
							>
								Everyone in the organization needs an authenticator app or a
								passkey. Members without one are asked to add it when they sign
								in, and lose access when the grace period ends. API keys and
								service accounts keep working.
							</p>
						</div>
						<Switch
							id="require-2fa"
							aria-describedby="require-2fa-msg"
							checked={required}
							disabled={disabled}
							onCheckedChange={(on) =>
								on
									? setConfirming(true)
									: apply({ mode: "off" }, "Two-factor is optional again")
							}
						/>
					</div>
					{required && (
						<>
							<div className="t-reveal flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
								<div className="min-w-0">
									<label htmlFor="grace-days" className="text-sm font-medium">
										Grace period
									</label>
									<p
										id="grace-days-msg"
										className="mt-1 max-w-[60ch] text-sm text-pretty text-muted-foreground"
									>
										Counted from when the requirement was switched on, or from
										the day someone joins, whichever is later.
									</p>
								</div>
								<Select
									value={String(setting.graceDays)}
									disabled={disabled}
									onValueChange={(v) =>
										apply(
											{ graceDays: Number(v) },
											`Grace period set to ${graceLabel(Number(v)).toLowerCase()}`,
										)
									}
								>
									<SelectTrigger
										id="grace-days"
										aria-describedby="grace-days-msg"
										className="w-full shrink-0 sm:w-44"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{GRACE_DAYS.map((d) => (
											<SelectItem key={d} value={String(d)}>
												{graceLabel(d)}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<div className="t-reveal flex items-start justify-between gap-6 p-4">
								<div className="min-w-0">
									<label htmlFor="trust-idp" className="text-sm font-medium">
										Trust the identity provider's MFA
									</label>
									<p
										id="trust-idp-msg"
										className="mt-1 max-w-[60ch] text-sm text-pretty text-muted-foreground"
									>
										Members who can only sign in through this organization's SSO
										count as enrolled, because their identity provider already
										asks for a second factor.
									</p>
								</div>
								<Switch
									id="trust-idp"
									aria-describedby="trust-idp-msg"
									checked={setting.trustIdpMfa}
									disabled={disabled}
									onCheckedChange={(on) =>
										apply(
											{ trustIdpMfa: on },
											on
												? "SSO sign-ins count as enrolled"
												: "SSO members need their own second factor",
										)
									}
								/>
							</div>
						</>
					)}
				</div>
			)}

			<Dialog open={confirming} onOpenChange={setConfirming}>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Require two-factor authentication?</DialogTitle>
						<DialogDescription>
							{without.length === 0
								? "Every member already has an authenticator app or a passkey."
								: `${without.length} of ${members?.length ?? 0} ${without.length === 1 ? "member has" : "members have"} no authenticator app or passkey yet. ${
										setting?.graceDays
											? `They get ${setting.graceDays} days to add one before their access pauses.`
											: "With no grace period, their access pauses as soon as you save."
									}`}
							{selfWithout &&
								" That includes you: add one from Account and security."}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="outline" onClick={() => setConfirming(false)}>
							Cancel
						</Button>
						<Button
							disabled={save.isPending}
							onClick={() =>
								apply({ mode: "required" }, "Two-factor is now required")
							}
						>
							Require it
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</Panel>
	);
}
