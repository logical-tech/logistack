import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { ChevronDown, Loader2, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { type BaseFeatures, DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import {
	ConfirmDelete,
	DataChip,
	Expiry,
} from "@/components/integrations/parts";
import { Page, PageHeader } from "@/components/page-header";
import { Panel, SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChoiceGroup } from "@/components/wizard/parts";
import { api } from "@/lib/api";
import {
	type AcmeDirectory,
	type CustomCertificate,
	certificatesQuery,
	issuerQuery,
	type ManagedCertificate,
	useInvalidating,
} from "@/lib/api/networking";
import { ACME_DIRECTORIES } from "@/lib/integrations";
import { section } from "@/lib/nav";

export const Route = createFileRoute("/_app/settings/certificates")({
	staticData: { crumb: "Certificates" },
	component: CertificatesPage,
});

const Names = ({ names }: { names: string[] }) => (
	<span className="flex min-w-0 flex-wrap gap-1">
		{names.slice(0, 3).map((n) => (
			<DataChip key={n}>{n}</DataChip>
		))}
		{names.length > 3 && (
			<span className="text-xs text-muted-foreground">+{names.length - 3}</span>
		)}
	</span>
);

const custom = createColumnHelper<BaseFeatures, CustomCertificate>();
const customColumns = (onDelete: (c: CustomCertificate) => void) =>
	custom.columns([
		custom.display({
			id: "name",
			header: "Certificate",
			meta: { className: "w-[38%] max-md:w-[62%]" },
			cell: ({ row: { original: c } }) => (
				<div className="grid min-w-0 gap-1 py-2.5">
					<span className="truncate font-medium">{c.name}</span>
					<Names names={c.sans} />
				</div>
			),
		}),
		custom.display({
			id: "issuer",
			header: "Issuer",
			meta: { className: "max-lg:hidden" },
			cell: ({ row: { original: c } }) => (
				<span className="block truncate text-muted-foreground" title={c.issuer}>
					{c.issuer}
				</span>
			),
		}),
		custom.display({
			id: "expiry",
			header: "Expires",
			meta: { className: "w-44 max-md:hidden" },
			cell: ({ row: { original: c } }) => <Expiry notAfter={c.notAfter} />,
		}),
		custom.display({
			id: "domains",
			header: "Used by",
			meta: { className: "w-28" },
			cell: ({ row: { original: c } }) => (
				<span className="tabular whitespace-nowrap text-muted-foreground">
					{c.domains === 0
						? "Unused"
						: `${c.domains} domain${c.domains === 1 ? "" : "s"}`}
				</span>
			),
		}),
		custom.display({
			id: "actions",
			header: () => <span className="sr-only">Actions</span>,
			meta: { className: "w-14 text-right" },
			cell: ({ row: { original: c } }) => (
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={`Delete ${c.name}`}
					onClick={() => onDelete(c)}
				>
					<Trash2 />
				</Button>
			),
		}),
	]);

const managed = createColumnHelper<BaseFeatures, ManagedCertificate>();
const managedColumns = managed.columns([
	managed.display({
		id: "names",
		header: "Names",
		meta: { className: "w-[45%] max-md:w-[55%]" },
		cell: ({ row: { original: c } }) => <Names names={c.names} />,
	}),
	managed.accessor("issuer", {
		header: "Issuer",
		meta: { className: "max-md:hidden" },
		cell: (c) => <span className="text-muted-foreground">{c.getValue()}</span>,
	}),
	managed.display({
		id: "expiry",
		header: "Expires",
		meta: { className: "w-44" },
		cell: ({ row: { original: c } }) => <Expiry notAfter={c.notAfter} />,
	}),
]);

function IssuerSettings() {
	const { data } = useQuery(issuerQuery);
	const [choice, setChoice] = useState<AcmeDirectory | null>(null);
	const save = useInvalidating(api.networking.certificates.setIssuer, [
		["certificates", "issuer"],
	]);
	const current = data?.directory;
	const value = choice ?? current;
	const dirty = Boolean(choice && choice !== current);
	return (
		<Collapsible className="group/adv">
			<CollapsibleTrigger className="flex items-center gap-1.5 rounded-sm text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring">
				Certificate authority
				<ChevronDown
					className="size-4 text-muted-foreground transition-transform duration-(--duration-fast) ease-(--ease-smooth-out) group-data-[state=open]/adv:rotate-180"
					aria-hidden
				/>
				{current && current !== "letsencrypt" && (
					<span className="ml-1 font-normal text-warn-text">
						{ACME_DIRECTORIES[current].label}
					</span>
				)}
			</CollapsibleTrigger>
			<CollapsibleContent className="grid gap-4 pt-3">
				<p className="max-w-[70ch] text-sm text-muted-foreground">
					Where every automatic certificate on this instance comes from. A
					change applies at the next proxy sync; certificates already issued are
					kept until they renew.
				</p>
				{value && (
					<ChoiceGroup
						label="Certificate authority"
						value={value}
						onChange={setChoice}
						choices={(Object.keys(ACME_DIRECTORIES) as AcmeDirectory[]).map(
							(d) => ({
								value: d,
								title: ACME_DIRECTORIES[d].label,
								description: ACME_DIRECTORIES[d].description,
								badge: d === current ? "Current" : undefined,
							}),
						)}
					/>
				)}
				<div className="flex items-center gap-3">
					<Button
						disabled={!dirty || save.isPending}
						onClick={async () => {
							if (!choice) return;
							try {
								await save.mutateAsync(choice);
								setChoice(null);
								toast.success(
									`Certificates now come from ${ACME_DIRECTORIES[choice].label}`,
								);
							} catch (err) {
								toast.error("Couldn't switch the authority", {
									description: err instanceof Error ? err.message : String(err),
								});
							}
						}}
					>
						{save.isPending && <Loader2 className="animate-spin" />}
						Save authority
					</Button>
					{dirty && (
						<Button variant="ghost" onClick={() => setChoice(null)}>
							Cancel
						</Button>
					)}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}

function CertificatesPage() {
	const s = section("/settings/certificates");
	const { data, isPending } = useQuery(certificatesQuery);
	const [deleting, setDeleting] = useState<CustomCertificate | null>(null);
	const remove = useInvalidating(api.networking.certificates.remove, [
		["certificates"],
	]);
	const upload = (variant: "default" | "outline" = "default") => (
		<Button asChild variant={variant}>
			<Link to="/settings/certificates/new">
				<Plus data-icon="inline-start" />
				Upload certificate
			</Link>
		</Button>
	);

	return (
		<Page>
			<PageHeader
				title={s.title}
				description={s.description}
				actions={upload()}
			/>
			<div className="grid gap-10">
				<Panel title="Issued automatically" id="managed-certs">
					{isPending ? (
						<SkeletonRows rows={3} />
					) : data?.managed.length ? (
						<DataTable
							label="Certificates Caddy manages"
							columns={managedColumns}
							data={data.managed}
							getRowId={(c) => c.names.join(",")}
						/>
					) : (
						<p className="px-4 py-6 text-sm text-muted-foreground">
							None yet. Caddy issues one the first time a domain with automatic
							HTTPS is routed, then renews it about 30 days before it expires.
						</p>
					)}
				</Panel>

				{isPending ? null : data?.custom.length ? (
					<Panel title="Uploaded" id="custom-certs">
						<DataTable
							label="Uploaded certificates"
							columns={customColumns(setDeleting)}
							data={data.custom}
							getRowId={(c) => c.id}
						/>
					</Panel>
				) : (
					<EmptyState
						icon={ShieldCheck}
						title={s.empty?.title ?? "No custom certificates"}
						description={s.empty?.body}
					>
						{upload("outline")}
					</EmptyState>
				)}

				<IssuerSettings />
			</div>
			<ConfirmDelete
				open={deleting !== null}
				onOpenChange={(o) => !o && setDeleting(null)}
				title={`Delete ${deleting?.name ?? "certificate"}?`}
				description="The certificate and its private key are erased. Domains using it must switch to another certificate first."
				onConfirm={async () => {
					if (!deleting) return;
					await remove.mutateAsync(deleting.id);
					toast.success(`${deleting.name} deleted`);
				}}
			/>
		</Page>
	);
}
