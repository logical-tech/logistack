import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { isOrgAdmin } from "@/components/access/members-dialogs";
import { Page, PageHeader } from "@/components/page-header";
import { SkeletonRows } from "@/components/panel";
import {
	RotateKeyButton,
	SecretsPanel,
} from "@/components/secrets/secrets-panel";
import { VariablesEditor } from "@/components/service/env-editor";
import { SlidingTabs } from "@/components/sliding-tabs";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useMe, useOrganization } from "@/lib/api/access";
import { useFolders } from "@/lib/api/folders";
import type { Folder } from "@/lib/api/types";
import { useReplaceVariables, variablesQuery } from "@/lib/api/variables";

export const Route = createFileRoute("/_app/settings/variables")({
	staticData: { crumb: "Secrets & variables" },
	validateSearch: z.object({
		tab: z.enum(["secrets", "variables"]).optional().catch(undefined),
		folder: z.string().startsWith("fld_").optional().catch(undefined),
	}),
	component: OrganizationVariables,
});

function Editor({ organizationId }: { organizationId: string }) {
	const { data } = useQuery(variablesQuery("organization", organizationId));
	const replace = useReplaceVariables("organization", organizationId);
	if (!data)
		return (
			<div className="overflow-hidden rounded-xl bg-card ring-1 ring-border">
				<SkeletonRows rows={4} />
			</div>
		);
	return (
		<VariablesEditor
			title="Organization variables"
			id="organization-vars"
			empty="None yet. Good candidates: a log level, a region, a public URL. Anything a project, environment or service sets wins over these."
			vars={data}
			save={replace.mutateAsync}
			savedHint="Services pick them up on their next deployment."
		/>
	);
}

/** "Clients / Acme Retail": a folder's place in the tree, for the scope picker. */
const folderPath = (f: Folder, all: Folder[]): string => {
	const parent = all.find((p) => p.id === f.parentId);
	return parent ? `${folderPath(parent, all)} / ${f.name}` : f.name;
};

function OrganizationVariables() {
	const { tab = "secrets", folder } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data: org } = useOrganization();
	const { data: me } = useMe();
	const { data: folders = [] } = useFolders();
	const current = folders.find((f) => f.id === folder);
	const ORG = "organization";

	return (
		<Page className="max-w-5xl">
			<PageHeader
				title="Secrets & variables"
				description="Secrets are encrypted and versioned; a service gets one only when its Environment tab references it. Plain variables reach every service in every project, unless a project, environment or service sets the same name."
				actions={isOrgAdmin(me) ? <RotateKeyButton /> : undefined}
			/>
			<div className="mb-5 border-b">
				<SlidingTabs
					label="Kind"
					idPrefix="kind"
					value={tab}
					onChange={(id) =>
						navigate({
							search: (s) => ({ ...s, tab: id === "secrets" ? undefined : id }),
							replace: true,
						})
					}
					items={[
						{ id: "secrets", label: "Secrets" },
						{ id: "variables", label: "Variables" },
					]}
				/>
			</div>
			<div id="kind-panel" role="tabpanel" aria-labelledby={`kind-tab-${tab}`}>
				{!org ? (
					<div className="overflow-hidden rounded-xl bg-card ring-1 ring-border">
						<SkeletonRows rows={4} />
					</div>
				) : tab === "variables" ? (
					<Editor organizationId={org.id} />
				) : (
					<div className="grid gap-4">
						{folders.length > 0 && (
							<div className="flex items-center gap-3">
								<span
									id="scope-label"
									className="text-sm text-muted-foreground"
								>
									Defined for
								</span>
								<Select
									value={current?.id ?? ORG}
									onValueChange={(v) =>
										navigate({
											search: (s) => ({
												...s,
												folder: v === ORG ? undefined : v,
											}),
											replace: true,
										})
									}
								>
									<SelectTrigger
										size="sm"
										aria-labelledby="scope-label"
										className="min-w-48"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value={ORG}>The whole organization</SelectItem>
										{folders.map((f) => (
											<SelectItem key={f.id} value={f.id}>
												{folderPath(f, folders)}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						)}
						{current ? (
							<SecretsPanel
								key={current.id}
								scope="folder"
								scopeId={current.id}
								id="folder-secrets"
								title={`${current.name} secrets`}
								empty={`None yet. Services in every project under ${current.name} can reference a secret defined here.`}
							/>
						) : (
							<SecretsPanel
								key={ORG}
								scope="organization"
								scopeId={org.id}
								id="organization-secrets"
								title="Organization secrets"
								empty="None yet. Good candidates: an email provider's API key, an error tracker's auth token. Any service in any project can reference them."
							/>
						)}
					</div>
				)}
			</div>
		</Page>
	);
}
