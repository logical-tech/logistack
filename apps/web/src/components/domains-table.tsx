import { Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { ArrowUpRight, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { type BaseFeatures, DataTable } from "@/components/data-table";
import { ConfirmDelete, Expiry } from "@/components/integrations/parts";
import { StatusLabel } from "@/components/status";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { type DomainListItem, useInvalidating } from "@/lib/api/networking";
import { TLS_MODES } from "@/lib/integrations";
import { DOMAIN_STATUS } from "@/lib/status";

const col = createColumnHelper<BaseFeatures, DomainListItem>();

function Certificate({ d }: { d: DomainListItem }) {
	if (d.tunnel)
		return <span className="text-muted-foreground">Cloudflare edge</span>;
	if (d.tls === "none")
		return <span className="text-muted-foreground">HTTP only</span>;
	if (!d.certificate)
		return (
			<span className="text-muted-foreground">
				{d.status === "error" ? "Not issued" : "Waiting for issuance"}
			</span>
		);
	return (
		<div className="min-w-0">
			<Expiry notAfter={d.certificate.notAfter} className="block truncate" />
			<span className="block truncate text-xs text-muted-foreground">
				{d.certificate.source === "custom"
					? (d.certificate.name ?? "Uploaded")
					: `Issued by ${d.certificate.issuer}`}
			</span>
		</div>
	);
}

function columns(actions: { onDelete: (d: DomainListItem) => void }) {
	return col.columns([
		col.display({
			id: "hostname",
			header: "Domain",
			meta: { className: "w-[34%] max-md:w-[56%]" },
			cell: ({ row: { original: d } }) => (
				<div className="min-w-0">
					<a
						href={`${d.https ? "https" : "http"}://${d.hostname.replace(/^\*\./, "")}${d.pathPrefix ?? ""}`}
						target="_blank"
						rel="noreferrer"
						className="group inline-flex max-w-full items-center gap-1 font-mono text-[13px] font-medium hover:underline"
					>
						<span className="truncate">
							{d.hostname}
							{d.pathPrefix && (
								<span className="text-muted-foreground">{d.pathPrefix}</span>
							)}
						</span>
						<ArrowUpRight
							className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-(--duration-quick) group-hover:opacity-100"
							aria-hidden
						/>
					</a>
					<Link
						to="/projects/$projectId"
						params={{ projectId: d.project.id }}
						search={{ env: d.environment.id }}
						className="block truncate text-xs text-muted-foreground hover:text-foreground"
					>
						{d.service.name} · {d.project.name} · {d.environment.name}
						{d.redirectTo && ` · redirects to ${d.redirectTo}`}
					</Link>
				</div>
			),
		}),
		col.display({
			id: "status",
			header: "Status",
			meta: { className: "w-[19%] max-md:w-auto" },
			cell: ({ row: { original: d } }) => (
				<div className="min-w-0">
					<StatusLabel meta={DOMAIN_STATUS[d.status]} />
					{d.statusMessage && (
						<span
							className="block truncate text-xs text-bad-text"
							title={d.statusMessage}
						>
							{d.statusMessage}
						</span>
					)}
				</div>
			),
		}),
		col.display({
			id: "tls",
			header: "TLS",
			meta: { className: "w-24 max-md:hidden" },
			cell: ({ row: { original: d } }) => (
				<span className="text-muted-foreground">
					{d.tunnel ? "Tunnel" : TLS_MODES[d.tls].short}
				</span>
			),
		}),
		col.display({
			id: "certificate",
			header: "Certificate",
			meta: { className: "max-md:hidden" },
			cell: ({ row: { original: d } }) => <Certificate d={d} />,
		}),
		col.display({
			id: "actions",
			header: () => <span className="sr-only">Actions</span>,
			meta: { className: "w-24 text-right max-md:w-20 max-md:pl-0" },
			cell: ({ row: { original: d } }) => (
				<div className="flex justify-end gap-1">
					<Button variant="ghost" size="icon-sm" asChild>
						<Link
							to="/domains/new"
							search={{ edit: d.id }}
							aria-label={`Edit ${d.hostname}`}
						>
							<Pencil />
						</Link>
					</Button>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={`Delete ${d.hostname}`}
						onClick={() => actions.onDelete(d)}
					>
						<Trash2 />
					</Button>
				</div>
			),
		}),
	]);
}

/** Domains with their status, TLS and certificate; edit opens the wizard, delete confirms. */
export function DomainsTable({ data }: { data: DomainListItem[] }) {
	const [deleting, setDeleting] = useState<DomainListItem | null>(null);
	const remove = useInvalidating(api.networking.domains.remove, [["domains"]]);
	return (
		<>
			<DataTable
				label="Domains"
				columns={columns({ onDelete: setDeleting })}
				data={data}
				getRowId={(d) => d.id}
			/>
			<ConfirmDelete
				open={deleting !== null}
				onOpenChange={(o) => !o && setDeleting(null)}
				title={`Delete ${deleting?.hostname ?? "domain"}?`}
				description={
					deleting?.dnsRecordId
						? "The proxy stops routing it, and the DNS record LogiStack created is removed from the provider."
						: "The proxy stops routing it at the next sync. DNS records you created yourself stay as they are."
				}
				onConfirm={async () => {
					if (!deleting) return;
					await remove.mutateAsync(deleting.id);
					toast.success(`${deleting.hostname} deleted`);
				}}
			/>
		</>
	);
}
