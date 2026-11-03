import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { CopyField } from "@/components/copy-button";
import { Field } from "@/components/field";
import { DataChip } from "@/components/integrations/parts";
import { Page, PageHeader } from "@/components/page-header";
import {
	type AutoJoinValues,
	autoJoinStep,
	domainOf,
	newProviderId,
} from "@/components/sso/auto-join";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Summary, TestPanel } from "@/components/wizard/parts";
import { Wizard, type WizardStep } from "@/components/wizard/wizard";
import { ApiError, api } from "@/lib/api";
import { type OidcDiscovery, serviceProviderQuery } from "@/lib/api/sso";
import { useSessionUser } from "@/lib/auth";
import { stepParam } from "@/lib/search";
import { SSO_TEST_CALLBACK, testSignIn } from "@/lib/sso-test";

export const Route = createFileRoute("/_app/settings/authentication_/oidc")({
	staticData: { crumb: "Add OIDC provider" },
	validateSearch: z.object({ step: stepParam }),
	component: NewOidcProvider,
});

type V = AutoJoinValues & {
	providerId: string;
	issuer: string;
	clientId: string;
	clientSecret: string;
};

const saved = (v: V) =>
	JSON.stringify([
		v.issuer,
		v.clientId,
		v.clientSecret,
		v.domain.trim().toLowerCase(),
		v.defaultRole,
	]);

function Discovered({ found }: { found: OidcDiscovery }) {
	const rows = [
		["Authorization", found.authorizationEndpoint],
		["Token", found.tokenEndpoint],
		["User info", found.userInfoEndpoint ?? "Not advertised"],
		["Keys (JWKS)", found.jwksUri],
	] as const;
	return (
		<dl className="t-reveal grid gap-x-6 gap-y-2 rounded-lg bg-card px-4 py-3.5 text-sm ring-1 ring-border sm:grid-cols-[8rem_minmax(0,1fr)]">
			{rows.map(([label, value]) => (
				<div key={label} className="contents">
					<dt className="text-muted-foreground">{label}</dt>
					<dd
						className="min-w-0 truncate font-mono text-xs leading-5"
						title={value}
					>
						{value}
					</dd>
				</div>
			))}
			<dt className="text-muted-foreground">Scopes</dt>
			<dd className="flex min-w-0 flex-wrap gap-1.5">
				{found.scopesSupported.length
					? found.scopesSupported.map((s) => <DataChip key={s}>{s}</DataChip>)
					: "Not advertised"}
			</dd>
		</dl>
	);
}

function RedirectUri({ providerId }: { providerId: string }) {
	const { data } = useQuery(serviceProviderQuery(providerId));
	return (
		<Field
			id="wz-redirect"
			label="Redirect URI"
			hint="Add it to the application at your identity provider, then copy its client ID and secret here."
		>
			{data ? (
				<CopyField value={data.redirectUri} label="Copy redirect URI" />
			) : (
				<div className="t-skel h-9 rounded-lg bg-muted/60" />
			)}
		</Field>
	);
}

function NewOidcProvider() {
	const { step } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const qc = useQueryClient();
	const user = useSessionUser();
	const [found, setFound] = useState<OidcDiscovery | null>(null);
	const [skipped, setSkipped] = useState(false);
	const [tested, setTested] = useState<string | null>(null);
	// The signature of the answers last saved: the test saves the provider, Finish reuses it.
	const savedAs = useRef<string | null>(null);

	const save = useCallback(async (v: V) => {
		const sig = saved(v);
		if (savedAs.current === sig) return;
		const input = {
			providerId: v.providerId,
			issuer: v.issuer.trim(),
			clientId: v.clientId.trim(),
			clientSecret: v.clientSecret,
			domain: v.domain.trim().toLowerCase(),
			defaultRole: v.defaultRole,
		};
		// Edited after a test, or left over from a reload: replace it, keeping the same redirect URI.
		if (savedAs.current) await api.sso.remove(v.providerId);
		await api.sso.createOidc(input).catch(async (err: unknown) => {
			if (!(err instanceof ApiError && err.status === 409)) throw err;
			await api.sso.remove(v.providerId);
			return api.sso.createOidc(input);
		});
		savedAs.current = sig;
	}, []);

	const steps = useMemo((): WizardStep<V>[] => {
		const auto = autoJoinStep<V>();
		return [
			{
				id: "issuer",
				title: "Identity provider",
				description:
					"The issuer URL of your OIDC provider. LogiStack reads its discovery document for the endpoints, so nothing else is typed by hand.",
				schema: z.object({
					issuer: z.url({
						protocol: /^https$/,
						error: "Enter the issuer's https URL.",
					}),
				}),
				testKeys: ["issuer"],
				test: async (v) => {
					setFound(null);
					try {
						const d = await api.sso.discover(v.issuer.trim());
						setFound(d);
						return {
							ok: true,
							message: `Found ${new URL(d.issuer).host}`,
							detail: `Discovery lists ${d.scopesSupported.length} scopes; LogiStack asks for openid, email and profile.`,
						};
					} catch (err) {
						return {
							ok: false,
							message: "No discovery document there",
							detail: err instanceof Error ? err.message : String(err),
						};
					}
				},
				render: (w) => (
					<div className="grid gap-5">
						<Field
							id="wz-issuer"
							label="Issuer URL"
							error={w.error("issuer")}
							hint="Okta: https://your-org.okta.com · Entra ID: https://login.microsoftonline.com/<tenant>/v2.0 · Google: https://accounts.google.com"
						>
							<Input
								{...w.bind("issuer")}
								autoFocus
								inputMode="url"
								autoCapitalize="none"
								spellCheck={false}
								placeholder="https://your-org.okta.com"
								className="font-mono"
							/>
						</Field>
						<TestPanel
							w={w}
							action="Discover"
							idle="LogiStack fetches /.well-known/openid-configuration from the issuer, from the server."
						/>
						{found && w.test.phase === "passed" && <Discovered found={found} />}
					</div>
				),
			},
			{
				id: "client",
				title: "Client credentials",
				description:
					"Create a web application at your identity provider for LogiStack, with the redirect URI below.",
				schema: z.object({
					clientId: z.string().trim().min(1, "Paste the client ID."),
					clientSecret: z.string().min(1, "Paste the client secret."),
				}),
				render: (w) => (
					<div className="grid max-w-xl gap-5">
						<RedirectUri providerId={w.values.providerId} />
						<Field
							id="wz-clientId"
							label="Client ID"
							error={w.error("clientId")}
						>
							<Input
								{...w.bind("clientId")}
								autoFocus
								autoComplete="off"
								spellCheck={false}
								className="font-mono"
							/>
						</Field>
						<Field
							id="wz-clientSecret"
							label="Client secret"
							error={w.error("clientSecret")}
							hint="Saved on the server and never shown again."
						>
							<Input
								{...w.bind("clientSecret")}
								type="password"
								autoComplete="off"
								spellCheck={false}
							/>
						</Field>
					</div>
				),
			},
			auto,
			{
				id: "test",
				title: "Test sign-in",
				description:
					"Saves the provider, then opens your identity provider in a new window. Sign in there with an account at your domain.",
				testKeys: [
					"issuer",
					"clientId",
					"clientSecret",
					"domain",
					"defaultRole",
				],
				test: skipped
					? undefined
					: async (v) => {
							const result = await testSignIn(async () => {
								await save(v);
								return api.sso.signInUrl(
									v.providerId,
									`${location.origin}${SSO_TEST_CALLBACK}`,
								);
							});
							if (result.ok) setTested(result.detail ?? "Passed");
							return result;
						},
				render: (w) =>
					skipped ? (
						<div
							role="status"
							className="t-swap grid gap-3 rounded-lg bg-warn/10 p-4 text-sm"
						>
							<p className="flex items-start gap-2 font-medium text-warn-text">
								<TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
								Saving without a tested sign-in
							</p>
							<p className="text-muted-foreground">
								A wrong secret or redirect URI only shows when someone first
								signs in, and they see an error from the identity provider.
							</p>
							<div>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => setSkipped(false)}
								>
									Test it instead
								</Button>
							</div>
						</div>
					) : (
						<div className="grid gap-4">
							<TestPanel
								w={w}
								action="Test sign-in"
								idle="The test signs this browser in as the account you use at the identity provider. Afterwards you may need to sign back in as yourself."
							/>
							{w.test.phase !== "passed" && (
								<p className="text-sm text-muted-foreground">
									No test account at hand?{" "}
									<button
										type="button"
										onClick={() => setSkipped(true)}
										className="font-medium text-foreground underline-offset-4 hover:underline"
									>
										Skip the test
									</button>
								</p>
							)}
						</div>
					),
			},
			{
				id: "review",
				title: "Review",
				description: skipped
					? "The provider is saved when you finish."
					: "The provider was saved by the test; finishing keeps it.",
				render: (w) => (
					<Summary
						w={w}
						sections={[
							{
								stepId: "issuer",
								title: "Identity provider",
								rows: [
									{
										label: "Issuer",
										value: (
											<span className="font-mono text-xs">
												{w.values.issuer}
											</span>
										),
									},
									{
										label: "Client ID",
										value: (
											<span className="font-mono text-xs">
												{w.values.clientId}
											</span>
										),
									},
									{ label: "Client secret", value: "Saved, never shown again" },
								],
							},
							{
								stepId: "auto-join",
								title: "Auto-join",
								rows: [
									{ label: "Email domain", value: `@${w.values.domain}` },
									{
										label: "Joins as",
										value: (
											<span className="capitalize">{w.values.defaultRole}</span>
										),
									},
								],
							},
							{
								stepId: "test",
								title: "Sign-in test",
								rows: [
									{
										label: "Result",
										value: skipped ? (
											<span className="text-warn-text">Skipped</span>
										) : (
											(tested ?? "Passed")
										),
									},
								],
							},
						]}
					/>
				),
			},
		];
	}, [found, skipped, tested, save]);

	const defaults = useMemo<V>(
		() => ({
			providerId: newProviderId("oidc"),
			issuer: "",
			clientId: "",
			clientSecret: "",
			domain: domainOf(user?.email),
			defaultRole: "developer",
		}),
		[user?.email],
	);

	const onStepChange = useCallback(
		(id: string, { replace }: { replace: boolean }) =>
			navigate({ search: { step: id }, replace }),
		[navigate],
	);

	return (
		<Page className="max-w-5xl">
			<PageHeader
				title="Add an OIDC provider"
				description="Okta, Entra ID, Google Workspace, Keycloak, Authentik or any OpenID Connect provider."
			/>
			<Wizard
				id="sso-oidc"
				steps={steps}
				defaultValues={defaults}
				secretKeys={["clientSecret"]}
				step={step}
				onStepChange={onStepChange}
				finishLabel="Finish"
				onComplete={async (v) => {
					await save(v);
					await qc.invalidateQueries({ queryKey: ["sso"] });
					toast.success(`${new URL(v.issuer).host} connected`, {
						description: `People at @${v.domain} can sign in with SSO.`,
					});
					await navigate({ to: "/settings/authentication" });
				}}
			/>
		</Page>
	);
}
