import type { WorkGuestInvited } from "@logistack/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { MessageSquare, SquarePlus } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { CopyField } from "@/components/copy-button";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ChoiceGroup, Summary } from "@/components/wizard/parts";
import { Wizard, type WizardStep } from "@/components/wizard/wizard";
import { useInviteWorkGuest } from "@/lib/api/work-queries";

type Answers = { email: string; permission: "comment" | "create" };

/**
 * Project ⋯ → "Invite guest" (plan 12.8): email → permissions → summary → copy the invite link.
 * A guest reads and comments on this one project and sees nothing else.
 */
export function InviteGuestDialog({
	projectId,
	projectName,
	open,
	onOpenChange,
}: {
	projectId: string;
	projectName: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [invited, setInvited] = useState<
		(WorkGuestInvited & { email: string }) | null
	>(null);
	const close = (o: boolean) => {
		onOpenChange(o);
		if (!o) setInvited(null);
	};
	return (
		<Dialog open={open} onOpenChange={close}>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>
						{invited ? "Invitation ready" : `Invite a guest to ${projectName}`}
					</DialogTitle>
					<DialogDescription>
						{invited
							? `Send this link to ${invited.email}. It works once and expires in 7 days.`
							: "For clients: they read tasks and comment on this project only, with no access to deployments, members or other projects."}
					</DialogDescription>
				</DialogHeader>
				{invited ? (
					<div className="t-reveal grid gap-4">
						<CopyField value={invited.url} label="Copy invite link" />
						{!invited.emailed && (
							<p className="text-sm text-muted-foreground">
								LogiStack didn't email it: share it the way you usually talk to
								this client.
							</p>
						)}
						<div className="flex justify-end">
							<Button onClick={() => close(false)}>Done</Button>
						</div>
					</div>
				) : (
					open && (
						<GuestWizard
							projectId={projectId}
							projectName={projectName}
							onInvited={setInvited}
						/>
					)
				)}
			</DialogContent>
		</Dialog>
	);
}

function GuestWizard({
	projectId,
	projectName,
	onInvited,
}: {
	projectId: string;
	projectName: string;
	onInvited: (i: WorkGuestInvited & { email: string }) => void;
}) {
	const [step, setStep] = useState<string>();
	const invite = useInviteWorkGuest();
	const qc = useQueryClient();
	const steps: WizardStep<Answers>[] = [
		{
			id: "who",
			title: "Who",
			schema: z.object({ email: z.email("Enter an email address") }),
			render: (w) => (
				<Field
					id="guest-email"
					label="Email"
					hint="They sign up with this address, or sign in if they already have an account."
					error={w.error("email")}
				>
					<Input
						{...w.bind("email")}
						type="email"
						placeholder="client@example.com"
						autoComplete="off"
						autoFocus
					/>
				</Field>
			),
		},
		{
			id: "permissions",
			title: "Permissions",
			render: (w) => (
				<ChoiceGroup
					label="What the guest can do"
					columns={1}
					value={w.values.permission}
					onChange={(v) => w.set("permission", v)}
					choices={[
						{
							value: "comment",
							title: "Read and comment",
							description:
								"See tasks, follow progress, discuss in comments and attach files.",
							icon: MessageSquare,
						},
						{
							value: "create",
							title: "Also create tasks",
							description:
								"New tasks from guests land in the backlog with a “From guest” tag. This turns it on for every guest of the project.",
							icon: SquarePlus,
						},
					]}
				/>
			),
		},
		{
			id: "summary",
			title: "Summary",
			render: (w) => (
				<Summary
					w={w}
					sections={[
						{
							stepId: "who",
							title: "Who",
							rows: [{ label: "Email", value: w.values.email }],
						},
						{
							stepId: "permissions",
							title: "Permissions",
							rows: [
								{ label: "Project", value: projectName },
								{
									label: "Can",
									value:
										w.values.permission === "create"
											? "Read, comment and create tasks"
											: "Read and comment",
								},
							],
						},
					]}
				/>
			),
		},
	];
	return (
		<Wizard
			id={`work-guest:${projectId}`}
			steps={steps}
			defaultValues={{ email: "", permission: "comment" } as Answers}
			step={step}
			onStepChange={(id) => setStep(id)}
			finishLabel="Create invitation"
			onComplete={async (v) => {
				const res = await invite.mutateAsync({
					projectId,
					input: {
						email: v.email.trim(),
						canCreate: v.permission === "create",
					},
				});
				await qc.invalidateQueries({ queryKey: ["access"] });
				onInvited({ ...res, email: v.email.trim() });
			}}
		/>
	);
}
