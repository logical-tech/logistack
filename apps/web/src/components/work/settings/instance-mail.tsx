import type { InstanceMail, InstanceMailInput } from "@logistack/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { Mail, Send, Server } from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { ConfirmDialog } from "@/components/access/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { Field } from "@/components/field";
import { Panel, SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
	ChoiceGroup,
	Instructions,
	Summary,
	TestPanel,
} from "@/components/wizard/parts";
import { Wizard, type WizardStep } from "@/components/wizard/wizard";
import { useMe } from "@/lib/api/access";
import {
	useInstanceMail,
	useRemoveInstanceMail,
	useTestInstanceMail,
	useUpdateInstanceMail,
} from "@/lib/api/work-queries";

/** Settings → Instance mail: the transport LogiStack sends notifications and invitations with. */

function NotAdmin() {
	return (
		<EmptyState
			icon={Server}
			title="Only instance admins set up email"
			description="Instance mail is shared by every organization on this server. Ask an instance admin to set it up."
		/>
	);
}

function Facts({ mail }: { mail: InstanceMail }) {
	const rows: [string, string][] =
		mail.transport === "smtp"
			? [
					["Transport", "SMTP"],
					[
						"Server",
						`${mail.host}:${mail.port}${mail.secure ? " (TLS)" : " (STARTTLS when offered)"}`,
					],
					["Username", mail.username || "None"],
					["Password", mail.hasSecret ? "Stored, encrypted" : "None"],
					["From", mail.from ?? ""],
				]
			: [
					["Transport", "Resend"],
					["API key", mail.hasSecret ? "Stored, encrypted" : "Missing"],
					["From", mail.from ?? ""],
				];
	return (
		<dl className="grid gap-x-6 gap-y-2.5 p-4 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
			{rows.map(([k, v]) => (
				<div key={k} className="contents">
					<dt className="text-muted-foreground">{k}</dt>
					<dd className="min-w-0 break-words">{v}</dd>
				</div>
			))}
		</dl>
	);
}

function TestSend() {
	const test = useTestInstanceMail();
	const [to, setTo] = useState("");
	const [result, setResult] = useState<{ ok: boolean; error: string | null }>();
	const submit = (e: FormEvent) => {
		e.preventDefault();
		if (!to.trim()) return;
		setResult(undefined);
		test.mutate(
			{ to: to.trim() },
			{
				onSuccess: setResult,
				onError: (err) => setResult({ ok: false, error: err.message }),
			},
		);
	};
	return (
		<form
			onSubmit={submit}
			className="flex flex-col gap-3 sm:flex-row sm:items-start"
		>
			<Field
				id="mail-test-to"
				label="Send a test email to"
				hint={
					result
						? undefined
						: "Check the inbox and the spam folder; delivery can take a minute."
				}
				error={result && !result.ok ? (result.error ?? "Not sent") : undefined}
				className="flex-1"
			>
				<Input
					id="mail-test-to"
					type="email"
					autoComplete="email"
					placeholder="you@company.com"
					value={to}
					onChange={(e) => setTo(e.target.value)}
					aria-describedby="mail-test-to-msg"
				/>
			</Field>
			<Button
				type="submit"
				variant="outline"
				className="sm:mt-7"
				disabled={!to.trim() || test.isPending}
			>
				<Send data-icon="inline-start" />
				{test.isPending ? "Sending…" : result?.ok ? "Sent" : "Send test"}
			</Button>
		</form>
	);
}

export function InstanceMailOverview() {
	const { data: me } = useMe();
	const allowed = me?.instanceAdmin === true;
	const { data: mail, isLoading } = useInstanceMail(allowed);
	const remove = useRemoveInstanceMail();
	const [confirm, setConfirm] = useState(false);
	if (me && !allowed) return <NotAdmin />;
	if (isLoading || !mail) return <SkeletonRows rows={4} />;
	if (!mail.configured)
		return (
			<EmptyState
				icon={Mail}
				title="LogiStack doesn't send email yet"
				description="Set up SMTP or Resend once. Then task notifications, daily digests and invitations go out by email instead of being copied by hand."
			>
				<Button asChild>
					<Link to="/settings/instance-mail/setup">Set up email</Link>
				</Button>
			</EmptyState>
		);
	return (
		<div className="grid gap-8">
			<Panel
				title="Transport"
				actions={
					<div className="flex gap-2">
						<Button asChild variant="outline" size="sm">
							<Link to="/settings/instance-mail/setup">Change</Link>
						</Button>
						<Button variant="ghost" size="sm" onClick={() => setConfirm(true)}>
							Turn off
						</Button>
					</div>
				}
			>
				<Facts mail={mail} />
			</Panel>
			<Panel title="Test" bodyClassName="p-4">
				<TestSend />
			</Panel>
			<ConfirmDialog
				open={confirm}
				onOpenChange={setConfirm}
				title="Turn instance email off?"
				description="Notifications stay in the inbox, but nobody gets them by email, and invitation links have to be shared by hand again. The stored credentials are deleted."
				confirmLabel="Turn off"
				onConfirm={() =>
					remove.mutateAsync(undefined).then(
						() => toast.success("Instance email is off"),
						(err: Error) => {
							toast.error("Couldn't turn email off", {
								description: err.message,
							});
							throw err;
						},
					)
				}
			/>
		</div>
	);
}

type V = {
	transport: "smtp" | "resend";
	host: string;
	port: string;
	secure: boolean;
	username: string;
	password: string;
	apiKey: string;
	from: string;
	testTo: string;
};

function toInput(v: V): InstanceMailInput {
	return v.transport === "smtp"
		? {
				transport: "smtp",
				host: v.host.trim(),
				port: Number(v.port),
				secure: v.secure,
				...(v.username.trim() ? { username: v.username.trim() } : {}),
				...(v.password ? { password: v.password } : {}),
				from: v.from.trim(),
			}
		: {
				transport: "resend",
				...(v.apiKey ? { apiKey: v.apiKey } : {}),
				from: v.from.trim(),
			};
}

function SetupWizard({
	mail,
	step,
	onStepChange,
}: {
	mail: InstanceMail;
	step: string | undefined;
	onStepChange: (id: string, opts: { replace: boolean }) => void;
}) {
	const navigate = useNavigate();
	const test = useTestInstanceMail();
	const update = useUpdateInstanceMail();
	const steps = useMemo((): WizardStep<V>[] => {
		const keeps = (v: V) => mail.hasSecret && mail.transport === v.transport;
		return [
			{
				id: "transport",
				title: "Transport",
				description: "How LogiStack hands mail over for delivery.",
				schema: z.object({ transport: z.enum(["smtp", "resend"]) }),
				render: (w) => (
					<ChoiceGroup
						label="Transport"
						value={w.values.transport}
						onChange={(t) => w.set("transport", t)}
						choices={[
							{
								value: "smtp",
								title: "SMTP",
								description:
									"Any mail server: your provider, Postmark, SES, Mailgun or your own.",
								icon: Server,
							},
							{
								value: "resend",
								title: "Resend",
								description:
									"An API key from resend.com and a verified domain.",
								icon: Send,
							},
						]}
					/>
				),
			},
			{
				id: "credentials",
				title: "Credentials",
				description:
					"Stored encrypted with the instance's master key; never shown again.",
				schema: (v) =>
					v.transport === "smtp"
						? z.object({
								host: z.string().trim().min(1, "The server's hostname"),
								port: z
									.string()
									.regex(/^\d+$/, "A port number")
									.refine(
										(p) => Number(p) >= 1 && Number(p) <= 65535,
										"1 to 65535",
									),
							})
						: z.object({
								apiKey: keeps(v)
									? z.string()
									: z.string().min(1, "Paste the API key"),
							}),
				render: (w) =>
					w.values.transport === "smtp" ? (
						<div className="grid gap-5">
							<div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_8rem]">
								<Field
									id={w.bind("host").id}
									label="Server"
									error={w.error("host")}
								>
									<Input
										{...w.bind("host")}
										placeholder="smtp.example.com"
										autoComplete="off"
										spellCheck={false}
									/>
								</Field>
								<Field
									id={w.bind("port").id}
									label="Port"
									error={w.error("port")}
								>
									<Input {...w.bind("port")} inputMode="numeric" />
								</Field>
							</div>
							<div className="flex items-start gap-3 text-sm">
								<Switch
									id="mail-secure"
									checked={w.values.secure}
									onCheckedChange={(on) => {
										w.set("secure", on);
										if (on && w.values.port === "587") w.set("port", "465");
										if (!on && w.values.port === "465") w.set("port", "587");
									}}
									className="mt-0.5"
								/>
								<label htmlFor="mail-secure">
									<span className="font-medium">Implicit TLS</span>
									<span className="block text-muted-foreground">
										For port 465. Off uses STARTTLS when the server offers it
										(port 587).
									</span>
								</label>
							</div>
							<div className="grid gap-5 sm:grid-cols-2">
								<Field id={w.bind("username").id} label="Username" optional>
									<Input {...w.bind("username")} autoComplete="off" />
								</Field>
								<Field
									id={w.bind("password").id}
									label="Password"
									optional
									hint={
										keeps(w.values)
											? "Leave empty to keep the stored password."
											: undefined
									}
								>
									<Input
										{...w.bind("password")}
										type="password"
										autoComplete="new-password"
									/>
								</Field>
							</div>
						</div>
					) : (
						<div className="grid gap-5">
							<Instructions
								href="https://resend.com/api-keys"
								link="Open Resend"
							>
								<p>
									Create an API key with <strong>Sending access</strong>, and
									verify the domain you'll send from under{" "}
									<strong>Domains</strong>.
								</p>
							</Instructions>
							<Field
								id={w.bind("apiKey").id}
								label="API key"
								error={w.error("apiKey")}
								hint={
									keeps(w.values)
										? "Leave empty to keep the stored key."
										: undefined
								}
							>
								<Input
									{...w.bind("apiKey")}
									type="password"
									placeholder="re_…"
									autoComplete="off"
									spellCheck={false}
								/>
							</Field>
						</div>
					),
			},
			{
				id: "from",
				title: "From address",
				description:
					"What recipients see. It must be an address the transport may send as.",
				schema: z.object({
					from: z
						.string()
						.trim()
						.min(3, "An address like LogiStack <ls@example.com>")
						.refine((s) => s.includes("@"), "Include an email address"),
				}),
				render: (w) => (
					<Field
						id={w.bind("from").id}
						label="From"
						error={w.error("from")}
						hint="A name in front is optional: LogiStack <ls@example.com>."
					>
						<Input
							{...w.bind("from")}
							placeholder="LogiStack <ls@example.com>"
							autoComplete="off"
						/>
					</Field>
				),
			},
			{
				id: "test",
				title: "Send a test",
				description:
					"One real email through these settings, before anything is saved.",
				schema: z.object({ testTo: z.email("An email address to send to") }),
				testKeys: [
					"transport",
					"host",
					"port",
					"secure",
					"username",
					"password",
					"apiKey",
					"from",
					"testTo",
				],
				test: async (v) => {
					try {
						const r = await test.mutateAsync({
							to: v.testTo.trim(),
							config: toInput(v),
						});
						return r.ok
							? {
									ok: true,
									message: `Sent to ${v.testTo.trim()}`,
									detail: "Check that it arrived, spam folder included.",
								}
							: {
									ok: false,
									message: "The email wasn't sent",
									detail: r.error ?? undefined,
								};
					} catch (err) {
						return {
							ok: false,
							message: "The email wasn't sent",
							detail: (err as Error).message,
						};
					}
				},
				render: (w) => (
					<div className="grid gap-5">
						<Field
							id={w.bind("testTo").id}
							label="Send to"
							error={w.error("testTo")}
						>
							<Input
								{...w.bind("testTo")}
								type="email"
								autoComplete="email"
								placeholder="you@company.com"
							/>
						</Field>
						<TestPanel
							w={w}
							action="Send test"
							idle="Nothing is saved until you finish."
						/>
					</div>
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
								stepId: "transport",
								title: "Transport",
								rows: [
									{
										label: "Transport",
										value: w.values.transport === "smtp" ? "SMTP" : "Resend",
									},
								],
							},
							{
								stepId: "credentials",
								title: "Credentials",
								rows:
									w.values.transport === "smtp"
										? [
												{
													label: "Server",
													value: `${w.values.host}:${w.values.port}${w.values.secure ? " (TLS)" : ""}`,
												},
												{
													label: "Username",
													value: w.values.username || "None",
												},
												{
													label: "Password",
													value: w.values.password
														? "New"
														: keeps(w.values)
															? "Unchanged"
															: "None",
												},
											]
										: [
												{
													label: "API key",
													value: w.values.apiKey ? "New" : "Unchanged",
												},
											],
							},
							{
								stepId: "from",
								title: "From address",
								rows: [{ label: "From", value: w.values.from }],
							},
						]}
					/>
				),
			},
		];
	}, [test.mutateAsync, mail]);

	return (
		<Wizard
			id="instance-mail"
			steps={steps}
			defaultValues={{
				transport: mail.transport ?? "smtp",
				host: mail.host ?? "",
				port: String(mail.port ?? 587),
				secure: mail.secure,
				username: mail.username ?? "",
				password: "",
				apiKey: "",
				from: mail.from ?? "",
				testTo: "",
			}}
			secretKeys={["password", "apiKey"]}
			step={step}
			onStepChange={onStepChange}
			finishLabel="Save and turn on"
			onComplete={async (v) => {
				await update.mutateAsync(toInput(v));
				toast.success("Instance email is on", {
					description: "Members can now choose email notifications.",
				});
				await navigate({ to: "/settings/instance-mail" });
			}}
		/>
	);
}

export function InstanceMailSetup({
	step,
	onStepChange,
}: {
	step: string | undefined;
	onStepChange: (id: string, opts: { replace: boolean }) => void;
}) {
	const { data: me } = useMe();
	const allowed = me?.instanceAdmin === true;
	const { data: mail } = useInstanceMail(allowed);
	if (me && !allowed) return <NotAdmin />;
	if (!mail) return <SkeletonRows rows={4} />;
	return <SetupWizard mail={mail} step={step} onStepChange={onStepChange} />;
}
