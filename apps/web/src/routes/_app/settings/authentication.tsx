import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
	FileCode2,
	LockKeyhole,
	Plus,
	ShieldCheck,
	Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import {
	ConfirmDelete,
	DataChip,
	KindTile,
} from "@/components/integrations/parts";
import { Page, PageHeader } from "@/components/page-header";
import { Panel, SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useInvalidating } from "@/lib/api/networking";
import { type SsoProvider, ssoProvidersQuery } from "@/lib/api/sso";
import { section } from "@/lib/nav";

export const Route = createFileRoute("/_app/settings/authentication")({
	staticData: { crumb: "Authentication" },
	loader: ({ context }) => {
		void context.queryClient.prefetchQuery(ssoProvidersQuery);
	},
	component: AuthenticationPage,
});

const KIND = {
	oidc: { label: "OIDC", icon: ShieldCheck },
	saml: { label: "SAML", icon: FileCode2 },
} as const;

function ProviderRow({
	p,
	onDelete,
}: {
	p: SsoProvider;
	onDelete: () => void;
}) {
	const kind = KIND[p.type];
	return (
		<li className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center">
			<div className="flex min-w-0 flex-1 items-center gap-3">
				<KindTile icon={kind.icon} />
				<div className="min-w-0">
					<p className="truncate font-mono text-sm" title={p.issuer}>
						{p.issuer}
					</p>
					<p className="text-xs text-muted-foreground">
						{kind.label}
						{p.clientIdLastFour && <> · client …{p.clientIdLastFour}</>}
					</p>
				</div>
			</div>
			<div className="flex items-center justify-between gap-4 sm:justify-end">
				<p className="min-w-0 text-sm text-muted-foreground">
					<DataChip>@{p.domain}</DataChip>{" "}
					{p.defaultRole ? (
						<>
							joins as{" "}
							<span className="font-medium text-foreground capitalize">
								{p.defaultRole}
							</span>
						</>
					) : (
						"no auto-join"
					)}
				</p>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={`Delete ${p.issuer}`}
					onClick={onDelete}
				>
					<Trash2 />
				</Button>
			</div>
		</li>
	);
}

function AuthenticationPage() {
	const s = section("/settings/authentication");
	const { data, isPending } = useQuery(ssoProvidersQuery);
	const [deleting, setDeleting] = useState<SsoProvider | null>(null);
	const remove = useInvalidating(api.sso.remove, [["sso"]]);

	const add = (
		<div className="flex flex-wrap gap-2">
			<Button asChild variant="outline">
				<Link to="/settings/authentication/saml">Add SAML provider</Link>
			</Button>
			<Button asChild>
				<Link to="/settings/authentication/oidc">
					<Plus data-icon="inline-start" />
					Add OIDC provider
				</Link>
			</Button>
		</div>
	);

	return (
		<Page>
			<PageHeader
				title={s.title}
				description={s.description}
				actions={data?.length ? add : undefined}
			/>
			{isPending ? (
				<Panel title="Identity providers" id="sso-providers">
					<SkeletonRows rows={2} />
				</Panel>
			) : !data?.length ? (
				<EmptyState
					icon={LockKeyhole}
					title={s.empty?.title ?? "No identity provider yet"}
					description={s.empty?.body}
				>
					{add}
				</EmptyState>
			) : (
				<div className="grid gap-8">
					<Panel title="Identity providers" id="sso-providers">
						<ul className="divide-y">
							{data.map((p) => (
								<ProviderRow
									key={p.providerId}
									p={p}
									onDelete={() => setDeleting(p)}
								/>
							))}
						</ul>
					</Panel>
					<p className="max-w-[70ch] text-sm text-muted-foreground">
						The sign-in page offers “Continue with SSO” while a provider exists.
						Someone whose email domain matches a provider signs in there and
						joins this organization with its role; existing members keep theirs.
					</p>
				</div>
			)}
			<ConfirmDelete
				open={deleting !== null}
				onOpenChange={(o) => !o && setDeleting(null)}
				title={`Delete ${deleting?.issuer ?? "provider"}?`}
				description="Nobody can sign in through it any more, and its linked sign-ins are removed. Members it brought in stay, with their roles."
				onConfirm={async () => {
					if (!deleting) return;
					await remove.mutateAsync(deleting.providerId);
					toast.success("Provider deleted");
				}}
			/>
		</Page>
	);
}
