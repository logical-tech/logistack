import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CircleAlert, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import {
	KindTile,
	S3_PROVIDER,
	s3ProviderOf,
} from "@/components/integration-kinds";
import { Page, PageHeader } from "@/components/page-header";
import { Panel, SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import {
	type S3Destination,
	s3DestinationsQuery,
	useDeleteS3Destination,
} from "@/lib/api/backups";
import { section } from "@/lib/nav";

export const Route = createFileRoute("/_app/integrations/s3")({
	staticData: { crumb: "S3 destinations" },
	loader: ({ context }) =>
		context.queryClient.prefetchQuery(s3DestinationsQuery),
	component: S3Page,
});

const SECTION = section("/integrations/s3");

const host = (endpoint: string) => {
	try {
		return new URL(endpoint).host;
	} catch {
		return endpoint;
	}
};

const usedBy = (n: number) =>
	n === 0 ? "Not used yet" : `Used by ${n} ${n === 1 ? "policy" : "policies"}`;

function DeleteDestination({
	target,
	onClose,
}: {
	target: S3Destination | null;
	onClose: () => void;
}) {
	const remove = useDeleteS3Destination();
	const [refusal, setRefusal] = useState<{
		title: string;
		message: string;
	} | null>(null);
	const close = () => {
		setRefusal(null);
		remove.reset();
		onClose();
	};
	return (
		<ConfirmDialog
			open={target !== null}
			onOpenChange={(open) => !open && close()}
			title={`Remove ${target?.name ?? "destination"}?`}
			description={
				target?.usedBy
					? `${usedBy(target.usedBy)}. Move those policies to another destination or delete them first; backups already in the bucket stay there.`
					: "Backups already in the bucket stay there. LogiStack forgets the credentials."
			}
			confirmLabel="Remove destination"
			pending={remove.isPending}
			onConfirm={() => {
				const d = target;
				if (!d) return;
				setRefusal(null);
				remove.mutate(d.id, {
					onSuccess: () => {
						toast.success(`${d.name} removed`);
						close();
					},
					onError: (e) =>
						setRefusal({
							title:
								e instanceof ApiError && e.status === 409
									? "Still in use"
									: "Couldn't remove it",
							message: e.message,
						}),
				});
			}}
		>
			{refusal && (
				<div
					role="alert"
					className="t-reveal flex gap-3 rounded-lg bg-bad/8 p-3.5 text-sm ring-1 ring-bad/25"
				>
					<CircleAlert
						className="mt-0.5 size-4 shrink-0 text-bad-text"
						aria-hidden
					/>
					<div className="grid gap-1">
						<p className="font-medium text-bad-text">{refusal.title}</p>
						<p className="text-muted-foreground first-letter:uppercase">
							{refusal.message}.
						</p>
					</div>
				</div>
			)}
		</ConfirmDialog>
	);
}

function DestinationRow({
	d,
	onDelete,
}: {
	d: S3Destination;
	onDelete: () => void;
}) {
	const provider = S3_PROVIDER[s3ProviderOf(d.endpoint)];
	return (
		<li className="grid items-center gap-x-6 gap-y-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_10rem]">
			<div className="flex min-w-0 items-center gap-3">
				<KindTile icon={provider.icon} />
				<div className="min-w-0">
					<p className="truncate text-sm font-medium">{d.name}</p>
					<p className="truncate text-xs text-muted-foreground">
						{provider.label}
						<span aria-hidden> · </span>
						<span className="font-mono">{host(d.endpoint)}</span>
					</p>
				</div>
			</div>
			<div className="min-w-0 max-sm:pl-11">
				<p className="truncate font-mono text-xs">
					{d.bucket}
					{d.prefix && (
						<span className="text-muted-foreground">/{d.prefix}</span>
					)}
				</p>
				<p className="truncate text-xs text-muted-foreground">
					{d.region}
					{d.forcePathStyle && " · path-style"}
				</p>
			</div>
			<div className="flex items-center justify-end gap-3 max-sm:justify-between max-sm:pl-11">
				<span className="text-xs whitespace-nowrap text-muted-foreground tabular">
					{usedBy(d.usedBy)}
				</span>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					aria-label={`Remove ${d.name}`}
					onClick={onDelete}
				>
					<Trash2 />
				</Button>
			</div>
		</li>
	);
}

function S3Page() {
	const { data } = useQuery(s3DestinationsQuery);
	const [deleting, setDeleting] = useState<S3Destination | null>(null);
	const empty = SECTION.empty;
	const add = (
		<Button asChild>
			<Link to="/integrations/s3/new">
				<Plus data-icon="inline-start" />
				Add destination
			</Link>
		</Button>
	);
	return (
		<Page className="max-w-4xl">
			<PageHeader
				title={SECTION.title}
				description={SECTION.description}
				actions={data?.length ? add : undefined}
			/>
			{!data ? (
				<div className="overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border">
					<SkeletonRows rows={3} />
				</div>
			) : data.length ? (
				<Panel
					title="Destinations"
					actions={
						<span className="text-xs text-muted-foreground">
							Pick one per backup policy
						</span>
					}
				>
					<ul className="divide-y">
						{data.map((d) => (
							<DestinationRow
								key={d.id}
								d={d}
								onDelete={() => setDeleting(d)}
							/>
						))}
					</ul>
				</Panel>
			) : (
				empty && (
					<EmptyState
						icon={SECTION.icon}
						title={empty.title}
						description={empty.body}
					>
						{add}
					</EmptyState>
				)
			)}
			<DeleteDestination target={deleting} onClose={() => setDeleting(null)} />
		</Page>
	);
}
