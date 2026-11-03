import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Field } from "@/components/field";
import { DataChip, Expiry } from "@/components/integrations/parts";
import { Page, PageHeader } from "@/components/page-header";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Summary, TestPanel } from "@/components/wizard/parts";
import { Wizard, type WizardStep } from "@/components/wizard/wizard";
import { api } from "@/lib/api";
import { type ParsedCertificate, useInvalidating } from "@/lib/api/networking";
import { stepParam } from "@/lib/search";

export const Route = createFileRoute("/_app/settings/certificates_/new")({
	staticData: { crumb: "Upload certificate" },
	validateSearch: z.object({ step: stepParam }),
	component: UploadCertificate,
});

type V = { name: string; certPem: string; privateKey: string };

const pem = (kind: string) =>
	z
		.string()
		.trim()
		.refine(
			(s) => s.includes("-----BEGIN") && s.includes("-----END"),
			`Paste the ${kind} in PEM form, including the BEGIN and END lines.`,
		);

function Parsed({ p }: { p: ParsedCertificate }) {
	return (
		<dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
			<dt className="text-muted-foreground">Names</dt>
			<dd className="flex flex-wrap gap-1">
				{p.sans.map((n) => (
					<DataChip key={n}>{n}</DataChip>
				))}
			</dd>
			<dt className="text-muted-foreground">Issuer</dt>
			<dd className="min-w-0 break-words">{p.issuer}</dd>
			<dt className="text-muted-foreground">Expires</dt>
			<dd>
				<Expiry notAfter={p.notAfter} />
			</dd>
		</dl>
	);
}

function UploadCertificate() {
	const { step } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const [parsed, setParsed] = useState<ParsedCertificate | null>(null);
	const create = useInvalidating(api.networking.certificates.create, [
		["certificates"],
	]);

	const steps = useMemo(
		(): WizardStep<V>[] => [
			{
				id: "pem",
				title: "Certificate and key",
				description:
					"The leaf certificate first, then any intermediates, and its unencrypted private key. The key is encrypted at rest and never shown again.",
				schema: z.object({
					certPem: pem("certificate"),
					privateKey: pem("private key"),
				}),
				render: (w) => (
					<div className="grid gap-4">
						<Field
							id="wz-certPem"
							label="Certificate chain"
							error={w.error("certPem")}
							hint="Starts with -----BEGIN CERTIFICATE-----."
						>
							<Textarea
								{...w.bind("certPem")}
								rows={8}
								spellCheck={false}
								className="font-mono text-xs"
								placeholder="-----BEGIN CERTIFICATE-----"
							/>
						</Field>
						<Field
							id="wz-privateKey"
							label="Private key"
							error={w.error("privateKey")}
							hint="RSA or ECDSA, PKCS#1, PKCS#8 or SEC1. No passphrase."
						>
							<Textarea
								{...w.bind("privateKey")}
								rows={6}
								spellCheck={false}
								autoComplete="off"
								className="font-mono text-xs [-webkit-text-security:disc]"
								placeholder="-----BEGIN PRIVATE KEY-----"
							/>
						</Field>
					</div>
				),
			},
			{
				id: "check",
				title: "Check the pair",
				description:
					"LogiStack parses both, confirms the key belongs to the certificate, and reads the names and expiry. Nothing is saved yet.",
				testKeys: ["certPem", "privateKey"],
				test: async (v) => {
					try {
						const p = await api.networking.certificates.inspect(
							v.certPem.trim(),
							v.privateKey.trim(),
						);
						setParsed(p);
						const days = Math.ceil(
							(new Date(p.notAfter).getTime() - Date.now()) / 86_400_000,
						);
						return days < 0
							? {
									ok: false,
									message: "This certificate has expired",
									detail: `It ended on ${new Date(p.notAfter).toLocaleDateString("en")}. Ask for a renewed one.`,
								}
							: {
									ok: true,
									message: `Valid for ${p.sans.length} name${p.sans.length === 1 ? "" : "s"}`,
									detail: `${p.sans[0]}${p.sans.length > 1 ? ` and ${p.sans.length - 1} more` : ""}, ${days} days left.`,
								};
					} catch (err) {
						return {
							ok: false,
							message: "The pair didn't validate",
							detail: err instanceof Error ? err.message : String(err),
						};
					}
				},
				render: (w) => (
					<div className="grid gap-5">
						<TestPanel
							w={w}
							action="Check certificate"
							idle="We'll parse the certificate and key without storing either."
						/>
						{parsed && w.test.phase === "passed" && (
							<div className="t-reveal rounded-lg bg-card p-4 ring-1 ring-border">
								<Parsed p={parsed} />
							</div>
						)}
					</div>
				),
			},
			{
				id: "name",
				title: "Name it",
				description: "Shown when you pick a certificate for a domain.",
				schema: z.object({
					name: z.string().trim().min(1, "Give it a name.").max(100),
				}),
				render: (w) => (
					<div className="grid max-w-md gap-4">
						<Field id="wz-name" label="Name" error={w.error("name")}>
							<Input
								{...w.bind("name")}
								autoFocus
								placeholder={
									parsed
										? `${parsed.sans[0]} (${parsed.issuer.split(" ")[0]})`
										: ""
								}
							/>
						</Field>
					</div>
				),
			},
			{
				id: "review",
				title: "Review and upload",
				render: (w) => (
					<Summary
						w={w}
						sections={[
							{
								stepId: "name",
								title: "Certificate",
								rows: [
									{ label: "Name", value: w.values.name },
									...(parsed
										? [
												{ label: "Names", value: parsed.sans.join(", ") },
												{ label: "Issuer", value: parsed.issuer },
												{
													label: "Expires",
													value: <Expiry notAfter={parsed.notAfter} />,
												},
											]
										: []),
									{ label: "Private key", value: "Encrypted on upload" },
								],
							},
						]}
					/>
				),
			},
		],
		[parsed],
	);

	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: { step: id }, replace }),
		[navigate],
	);

	return (
		<Page className="max-w-5xl">
			<PageHeader
				title="Upload a certificate"
				description="For domains whose certificate a client or a CA gave you. Let's Encrypt covers the rest on its own."
			/>
			<Wizard
				id="certificate-upload"
				steps={steps}
				defaultValues={{ name: "", certPem: "", privateKey: "" }}
				secretKeys={["privateKey"]}
				step={step}
				onStepChange={onStepChange}
				finishLabel="Upload certificate"
				onComplete={async (v) => {
					const c = await create.mutateAsync({
						name: v.name.trim(),
						certPem: v.certPem.trim(),
						privateKey: v.privateKey.trim(),
					});
					toast.success(`${c.name} uploaded`, {
						description: "Pick it in a domain's HTTPS step.",
					});
					await navigate({ to: "/settings/certificates" });
				}}
			/>
		</Page>
	);
}
