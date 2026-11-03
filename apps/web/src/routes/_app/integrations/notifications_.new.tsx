import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Field } from "@/components/field";
import {
	ConfigFields,
	type ConfigSchema,
	type ConfigValues,
	initialValues,
	missingFields,
	toConfig,
} from "@/components/integrations/config-form";
import { Page, PageHeader } from "@/components/page-header";
import { Input } from "@/components/ui/input";
import { ChoiceGroup, Summary, TestPanel } from "@/components/wizard/parts";
import { Wizard, type WizardStep } from "@/components/wizard/wizard";
import { api } from "@/lib/api";
import {
	type ChannelKind,
	schemasQuery,
	useInvalidating,
} from "@/lib/api/networking";
import { CHANNEL_KINDS } from "@/lib/integrations";
import { stepParam } from "@/lib/search";

export const Route = createFileRoute("/_app/integrations/notifications_/new")({
	staticData: { crumb: "Add channel" },
	validateSearch: z.object({ step: stepParam }),
	component: NewChannel,
});

type V = { kind: ChannelKind; config: ConfigValues; name: string };

const HINTS: Partial<Record<ChannelKind, Record<string, string>>> = {
	slack: { webhookUrl: "Slack → Apps → Incoming Webhooks → Add to a channel." },
	discord: {
		webhookUrl: "Channel settings → Integrations → Webhooks → Copy URL.",
	},
	teams: {
		webhookUrl:
			"The channel's Workflows → “Post to a channel when a webhook request is received”.",
	},
	telegram: {
		botToken: "From @BotFather after /newbot.",
		chatId: "The chat or group id; add the bot to the group first.",
	},
	webhook: {
		secret:
			"At least 16 characters. Receivers check X-LogiStack-Signature with it.",
	},
	ntfy: { topic: "Letters, digits, dashes and underscores." },
	email: {
		to: "Separate several addresses with commas.",
		from: "Like LogiStack <ops@example.com>.",
	},
};

function NewChannel() {
	const { step } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: schemas } = useQuery(schemasQuery);
	const create = useInvalidating(api.networking.notifications.createChannel, [
		["notification-channels"],
	]);
	const schemaOf = useCallback(
		(kind: ChannelKind) => schemas?.notify[kind] as ConfigSchema | undefined,
		[schemas],
	);

	const steps = useMemo((): WizardStep<V>[] => {
		const config = (v: V) => {
			const s = schemaOf(v.kind);
			return s ? toConfig(s, v.config) : {};
		};
		return [
			{
				id: "kind",
				title: "Where should alerts go?",
				description:
					"One channel per destination. Rules decide which events reach it.",
				render: (w) => (
					<ChoiceGroup
						label="Channel"
						value={w.values.kind}
						onChange={(kind) => {
							w.set("kind", kind);
							const s = schemaOf(kind);
							w.set("config", s ? initialValues(s) : {});
						}}
						choices={(Object.keys(CHANNEL_KINDS) as ChannelKind[]).map((k) => ({
							value: k,
							title: CHANNEL_KINDS[k].label,
							description: CHANNEL_KINDS[k].blurb,
							icon: CHANNEL_KINDS[k].icon,
						}))}
					/>
				),
			},
			{
				id: "configure",
				title: "Connect it",
				description:
					"Masked fields are credentials: they are encrypted at rest and never shown again.",
				schema: (v) =>
					z.object({ config: z.any() }).superRefine((_, ctx) => {
						const s = schemaOf(v.kind);
						if (s && Object.keys(missingFields(s, v.config)).length)
							ctx.addIssue({
								code: "custom",
								path: ["config"],
								message: "Fill in the required fields.",
							});
					}),
				render: (w) => {
					const s = schemaOf(w.values.kind);
					if (!s) return null;
					return (
						<ConfigFields
							schema={s}
							idPrefix="wz-cfg"
							values={w.values.config}
							onChange={(c) => w.set("config", c)}
							errors={
								w.error("config") ? missingFields(s, w.values.config) : {}
							}
							hints={HINTS[w.values.kind]}
						/>
					);
				},
			},
			{
				id: "test",
				title: "Send a test",
				description:
					"A short message goes out now, so you can see where it lands and how it looks.",
				testKeys: ["kind", "config"],
				test: async (v) => {
					try {
						await api.networking.notifications.testConfig(v.kind, config(v));
						return {
							ok: true,
							message: `Sent through ${CHANNEL_KINDS[v.kind].label}`,
							detail: "Check that “LogiStack test notification” arrived.",
						};
					} catch (err) {
						return {
							ok: false,
							message: "The message didn't go out",
							detail: err instanceof Error ? err.message : String(err),
						};
					}
				},
				render: (w) => (
					<TestPanel
						w={w}
						action="Send test"
						idle={`We'll send “LogiStack test notification” through ${CHANNEL_KINDS[w.values.kind].label}.`}
					/>
				),
			},
			{
				id: "name",
				title: "Name it",
				description: "Rules and delivery errors refer to it by this name.",
				schema: z.object({
					name: z.string().trim().min(1, "Give the channel a name.").max(100),
				}),
				render: (w) => (
					<div className="grid max-w-md gap-4">
						<Field id="wz-name" label="Name" error={w.error("name")}>
							<Input {...w.bind("name")} autoFocus placeholder="#ops-alerts" />
						</Field>
					</div>
				),
			},
			{
				id: "review",
				title: "Review and add",
				description: "Next, pick the events that should reach it.",
				render: (w) => (
					<Summary
						w={w}
						sections={[
							{
								stepId: "kind",
								title: "Channel",
								rows: [
									{ label: "Kind", value: CHANNEL_KINDS[w.values.kind].label },
									{ label: "Name", value: w.values.name },
									{ label: "Test message", value: "Delivered" },
								],
							},
						]}
					/>
				),
			},
		];
	}, [schemaOf]);

	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: { step: id }, replace }),
		[navigate],
	);

	if (!schemas) return null;

	return (
		<Page className="max-w-5xl">
			<PageHeader
				title="Add a notification channel"
				description="Deployments, certificates, backups and nodes, delivered where your team already looks."
			/>
			<Wizard<V>
				id="notification-channel"
				steps={steps}
				defaultValues={{
					kind: "slack",
					config: initialValues(schemas.notify.slack as ConfigSchema),
					name: "",
				}}
				secretKeys={["config"]}
				step={step}
				onStepChange={onStepChange}
				finishLabel="Add channel"
				onComplete={async (v) => {
					const s = schemaOf(v.kind);
					const ch = await create.mutateAsync({
						kind: v.kind,
						name: v.name.trim(),
						config: s ? toConfig(s, v.config) : {},
					});
					toast.success(`${ch.name} added`, {
						description: "Choose which events it receives.",
					});
					await navigate({
						to: "/integrations/notifications",
						search: { rule: ch.id },
					});
				}}
			/>
		</Page>
	);
}
