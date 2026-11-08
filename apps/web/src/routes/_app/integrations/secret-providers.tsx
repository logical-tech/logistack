import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { KeyRound, Loader2, PlugZap, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { ConfirmDelete, KindTile } from "@/components/integrations/parts";
import { Page, PageHeader } from "@/components/page-header";
import { Panel, SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useInvalidating } from "@/lib/api/networking";
import { type SecretProvider, secretProvidersQuery } from "@/lib/api/secrets";
import { relativeTime } from "@/lib/format";
import { SECRET_PROVIDER_KINDS } from "@/lib/integrations";
import { section } from "@/lib/nav";

export const Route = createFileRoute("/_app/integrations/secret-providers")({
	staticData: { crumb: "Secret providers" },
	component: SecretProvidersPage,
});

function ProviderRow({
	p,
	onDelete,
}: {
	p: SecretProvider;
	onDelete: () => void;
}) {
	const kind = SECRET_PROVIDER_KINDS[p.kind];
	const [testing, setTesting] = useState(false);
	const test = async () => {
		setTesting(true);
		try {
			await api.secrets.providers.test(p.id);
			toast.success(`${p.name} is reachable`, {
				description: "Signed in with the saved credentials.",
			});
		} catch (err) {
			toast.error(`${p.name} didn't answer`, {
				description: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setTesting(false);
		}
	};
	return (
		<li className="grid gap-3 px-4 py-3.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto] sm:items-center">
			<div className="flex min-w-0 items-center gap-3">
				<KindTile icon={kind.icon} />
				<div className="min-w-0">
					<p className="truncate font-mono text-sm">secret://{p.name}/</p>
					<p className="text-xs text-muted-foreground">
						{kind.label} · added {relativeTime(p.createdAt)}
					</p>
				</div>
			</div>
			<div className="min-w-0">
				<p className="truncate font-mono text-xs text-muted-foreground">
					{p.url}
				</p>
				<p className="tabular text-xs text-muted-foreground">
					{p.secrets === 0
						? "No secrets read from it yet"
						: `${p.secrets} secret${p.secrets === 1 ? "" : "s"}`}
				</p>
			</div>
			<div className="flex items-center gap-1 sm:justify-end">
				<Button variant="ghost" size="sm" onClick={test} disabled={testing}>
					{testing ? (
						<Loader2 data-icon="inline-start" className="animate-spin" />
					) : (
						<PlugZap data-icon="inline-start" />
					)}
					Test
				</Button>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={`Remove ${p.name}`}
					onClick={onDelete}
				>
					<Trash2 />
				</Button>
			</div>
		</li>
	);
}

function SecretProvidersPage() {
	const s = section("/integrations/secret-providers");
	const { data, isPending } = useQuery(secretProvidersQuery);
	const [deleting, setDeleting] = useState<SecretProvider | null>(null);
	const remove = useInvalidating(api.secrets.providers.remove, [
		["secret-providers"],
	]);

	const add = (
		<Button asChild>
			<Link to="/integrations/secret-providers/new">
				<Plus data-icon="inline-start" />
				Add provider
			</Link>
		</Button>
	);

	return (
		<Page>
			<PageHeader
				title={s.title}
				description={s.description}
				actions={data?.length ? add : undefined}
			/>
			{isPending ? (
				<Panel title="Providers" id="secret-providers">
					<SkeletonRows rows={2} />
				</Panel>
			) : !data?.length ? (
				<EmptyState
					icon={KeyRound}
					title={s.empty?.title ?? "No secret providers"}
					description={s.empty?.body}
				>
					{add}
				</EmptyState>
			) : (
				<div className="grid gap-8">
					<Panel title="Providers" id="secret-providers">
						<ul className="divide-y">
							{data.map((p) => (
								<ProviderRow key={p.id} p={p} onDelete={() => setDeleting(p)} />
							))}
						</ul>
					</Panel>
					<p className="max-w-[70ch] text-sm text-pretty text-muted-foreground">
						Create a secret with a reference such as{" "}
						<code className="font-mono text-foreground">
							secret://{data[0]?.name}/
							{SECRET_PROVIDER_KINDS[data[0]?.kind ?? "vault"].example}
						</code>
						, or type one as a service variable's value. It is read at deploy
						time and never stored here; a failed read fails the deployment
						before anything changes.
					</p>
				</div>
			)}
			<ConfirmDelete
				open={deleting !== null}
				onOpenChange={(o) => !o && setDeleting(null)}
				title={`Remove ${deleting?.name ?? "provider"}?`}
				description="LogiStack forgets the credentials. Nothing in the provider changes. A provider that secrets still read from can't be removed."
				action="Remove"
				onConfirm={async () => {
					if (!deleting) return;
					await remove.mutateAsync(deleting.id);
					toast.success(`${deleting.name} removed`);
				}}
			/>
		</Page>
	);
}
