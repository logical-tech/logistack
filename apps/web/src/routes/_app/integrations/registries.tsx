import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyField } from "@/components/copy-button";
import { EmptyState } from "@/components/empty-state";
import { KindTile, REGISTRY_KIND } from "@/components/integration-kinds";
import { Page, PageHeader } from "@/components/page-header";
import { Panel, SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { ChoiceGroup } from "@/components/wizard/parts";
import {
	integrations,
	type Registries,
	type Registry,
	registriesQuery,
	useDeleteRegistry,
	useSetLocalRegistry,
	useUpdateRegistry,
} from "@/lib/api/integrations";
import { section } from "@/lib/nav";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/integrations/registries")({
	staticData: { crumb: "Registries" },
	loader: ({ context }) => context.queryClient.prefetchQuery(registriesQuery),
	component: RegistriesPage,
});

const SECTION = section("/integrations/registries");

function LocalRegistry({ data }: { data: Registries }) {
	const { local } = data;
	const row = data.registries.find((r) => r.id === local.registryId);
	const setLocal = useSetLocalRegistry();
	const [turningOff, setTurningOff] = useState(false);
	const [purge, setPurge] = useState<"keep" | "purge">("keep");
	const [reveal, setReveal] = useState(false);
	const switchId = useId();

	const apply = (enabled: boolean, purgeImages = false) =>
		setLocal.mutate(
			{ enabled, purge: purgeImages },
			{
				onSuccess: () => {
					setTurningOff(false);
					setReveal(false);
					toast.success(
						enabled
							? "Local registry is starting"
							: purgeImages
								? "Local registry removed with its images"
								: "Local registry turned off",
						{
							description: enabled
								? "The worker brings it up within about 30 seconds."
								: "The worker stops it within about 30 seconds.",
						},
					);
				},
				onError: (e) =>
					toast.error("Couldn't change the local registry", {
						description: e.message,
					}),
			},
		);

	return (
		<Panel title="Local registry" bodyClassName="divide-y">
			<div className="flex items-start gap-3 p-4">
				<KindTile icon={REGISTRY_KIND.local.icon} />
				<div className="min-w-0 flex-1">
					<label htmlFor={switchId} className="flex items-center gap-2">
						<span className="text-sm font-medium">Registry on this server</span>
						{local.enabled && row?.isDefault && (
							<span className="rounded-sm bg-muted px-1.5 py-px text-2xs font-medium text-muted-foreground">
								Default
							</span>
						)}
					</label>
					<p className="mt-0.5 max-w-[62ch] text-sm text-muted-foreground">
						{local.url
							? "Images stay on your servers, behind the proxy with generated credentials. Turning it on makes it the default."
							: "Needs the instance domain from setup, so it can be served on registry.<domain>."}
					</p>
				</div>
				<Switch
					id={switchId}
					checked={local.enabled}
					disabled={!local.url || setLocal.isPending}
					onCheckedChange={(on) => {
						if (on) apply(true);
						else {
							setPurge("keep");
							setTurningOff(true);
						}
					}}
					aria-describedby={`${switchId}-note`}
				/>
			</div>
			{local.enabled && local.url && (
				<div className="grid gap-3 p-4">
					<div className="grid gap-1.5 sm:grid-cols-[7rem_minmax(0,1fr)] sm:items-center">
						<span className="text-sm text-muted-foreground">Address</span>
						<CopyField value={local.url} label="Copy registry address" />
					</div>
					{reveal && row ? (
						<Credentials registry={row} onHide={() => setReveal(false)} />
					) : (
						<div className="sm:pl-[calc(7rem+0.375rem)]">
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => setReveal(true)}
								disabled={!row}
							>
								Show credentials for docker login
							</Button>
						</div>
					)}
				</div>
			)}
			<p
				id={`${switchId}-note`}
				className="bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground dark:bg-muted/20"
			>
				Changes apply when the worker next converges, within about 30 seconds.
			</p>

			<ConfirmDialog
				open={turningOff}
				onOpenChange={setTurningOff}
				title="Turn off the local registry?"
				description="The registry service stops and is no longer the default. Running services keep running; choose another default before the next build."
				confirmLabel={
					purge === "purge" ? "Turn off and delete images" : "Turn off"
				}
				destructive={purge === "purge"}
				pending={setLocal.isPending}
				onConfirm={() => apply(false, purge === "purge")}
			>
				<ChoiceGroup
					label="Stored images"
					columns={1}
					value={purge}
					onChange={setPurge}
					choices={[
						{
							value: "keep",
							title: "Keep images",
							description:
								"Turn it back on later and every image and credential is still there.",
						},
						{
							value: "purge",
							title: "Delete images and credentials",
							description:
								"Frees the disk. Rollbacks to images built here stop working. This can't be undone.",
						},
					]}
				/>
			</ConfirmDialog>
		</Panel>
	);
}

function Credentials({
	registry,
	onHide,
}: {
	registry: Registry;
	onHide: () => void;
}) {
	const { data, isPending, error } = useQuery({
		queryKey: ["registries", registry.id, "credentials"],
		queryFn: () => integrations.registries.credentials(registry.id),
		gcTime: 0,
		staleTime: 0,
	});
	if (isPending)
		return (
			<p className="text-sm text-muted-foreground">Loading credentials…</p>
		);
	if (error)
		return (
			<p className="text-sm text-bad-text">
				Couldn't load the credentials: {error.message}
			</p>
		);
	const rows = [
		{ label: "Username", value: data.username ?? "", copy: "Copy username" },
		{ label: "Password", value: data.password ?? "", copy: "Copy password" },
		{
			label: "Command",
			value: `docker login ${registry.url} -u ${data.username ?? ""}`,
			copy: "Copy docker login command",
		},
	];
	return (
		<div className="t-reveal grid gap-3">
			{rows.map((r) => (
				<div
					key={r.label}
					className="grid gap-1.5 sm:grid-cols-[7rem_minmax(0,1fr)] sm:items-center"
				>
					<span className="text-sm text-muted-foreground">{r.label}</span>
					<CopyField value={r.value} label={r.copy} />
				</div>
			))}
			<div className="flex flex-wrap items-center justify-between gap-2 sm:pl-[calc(7rem+0.375rem)]">
				<p className="text-xs text-muted-foreground">
					Docker asks for the password; it never goes on the command line.
				</p>
				<Button type="button" variant="ghost" size="sm" onClick={onHide}>
					Hide
				</Button>
			</div>
		</div>
	);
}

/** "Keep last N images per service", saved on blur or Enter. */
function Retention({ registry }: { registry: Registry }) {
	const update = useUpdateRegistry();
	const [value, setValue] = useState(String(registry.keepTags));
	useEffect(() => setValue(String(registry.keepTags)), [registry.keepTags]);
	const id = `keep-${registry.id}`;

	const save = () => {
		const n = Number(value);
		if (!Number.isInteger(n) || n < 1 || n > 500) {
			toast.error("Keep between 1 and 500 images");
			setValue(String(registry.keepTags));
			return;
		}
		if (n === registry.keepTags) return;
		update.mutate(
			{ id: registry.id, keepTags: n },
			{
				onSuccess: () =>
					toast.success(
						`${registry.url} keeps the last ${n} images per service`,
					),
				onError: (e) => {
					setValue(String(registry.keepTags));
					toast.error("Couldn't change retention", { description: e.message });
				},
			},
		);
	};

	return (
		<label
			htmlFor={id}
			className="flex items-center gap-2 text-sm whitespace-nowrap text-muted-foreground"
		>
			Keep last
			<Input
				id={id}
				type="number"
				inputMode="numeric"
				min={1}
				max={500}
				value={value}
				onChange={(e) => setValue(e.target.value)}
				onBlur={save}
				onKeyDown={(e) => {
					if (e.key === "Enter") e.currentTarget.blur();
				}}
				className="h-7 w-16 text-center tabular"
				aria-describedby={`${id}-unit`}
			/>
			<span id={`${id}-unit`}>images per service</span>
		</label>
	);
}

function RegistryList({ data }: { data: Registries }) {
	const update = useUpdateRegistry();
	const remove = useDeleteRegistry();
	const [deleting, setDeleting] = useState<Registry | null>(null);
	const rows = data.registries.filter(
		(r) => r.kind !== "local" || data.local.enabled,
	);
	const current = rows.find((r) => r.isDefault)?.id ?? "";

	return (
		<Panel
			title="Push to"
			actions={
				<span className="text-xs text-muted-foreground">
					Builds push to the default
				</span>
			}
		>
			<RadioGroup
				value={current}
				aria-label="Default registry"
				className="gap-0 divide-y"
				onValueChange={(id) =>
					update.mutate(
						{ id, isDefault: true },
						{
							onError: (e) =>
								toast.error("Couldn't change the default", {
									description: e.message,
								}),
						},
					)
				}
			>
				{rows.map((r) => {
					const kind = REGISTRY_KIND[r.kind];
					const radio = `default-${r.id}`;
					return (
						<div
							key={r.id}
							className={cn(
								"flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3 transition-colors duration-(--duration-quick)",
								r.isDefault && "bg-muted/40 dark:bg-muted/25",
							)}
						>
							<div className="flex min-w-0 flex-1 basis-64 items-center gap-3">
								<RadioGroupItem
									id={radio}
									value={r.id}
									aria-label={`Make ${r.url} the default`}
									disabled={update.isPending}
								/>
								<KindTile icon={kind.icon} />
								<label htmlFor={radio} className="min-w-0 cursor-pointer">
									<span className="flex items-center gap-2">
										<span className="truncate font-mono text-xs">{r.url}</span>
										{r.isDefault && (
											<span className="shrink-0 rounded-sm bg-muted px-1.5 py-px text-2xs font-medium text-muted-foreground">
												Default
											</span>
										)}
									</span>
									<span className="block truncate text-xs text-muted-foreground">
										{kind.label}
										{r.kind !== "local" &&
											(r.username ? ` · ${r.username}` : " · anonymous")}
									</span>
								</label>
							</div>
							<div className="ml-auto flex items-center gap-2 max-sm:w-full max-sm:justify-between max-sm:pl-7">
								<Retention registry={r} />
								{r.kind === "local" ? (
									<span className="size-7" aria-hidden />
								) : (
									<Button
										type="button"
										variant="ghost"
										size="icon-sm"
										aria-label={`Remove ${r.url}`}
										onClick={() => setDeleting(r)}
									>
										<Trash2 />
									</Button>
								)}
							</div>
						</div>
					);
				})}
			</RadioGroup>

			<ConfirmDialog
				open={deleting !== null}
				onOpenChange={(open) => !open && setDeleting(null)}
				title={`Remove ${deleting?.url ?? "registry"}?`}
				description={
					deleting?.isDefault
						? "Images already pushed stay in the registry. Builds stop pushing to it, and there is no default until you choose one."
						: "Images already pushed stay in the registry. Builds stop pushing to it."
				}
				confirmLabel="Remove registry"
				pending={remove.isPending}
				onConfirm={() => {
					const r = deleting;
					if (!r) return;
					remove.mutate(r.id, {
						onSuccess: () => {
							setDeleting(null);
							toast.success(`${r.url} removed`);
						},
						onError: (e) =>
							toast.error("Couldn't remove the registry", {
								description: e.message,
							}),
					});
				}}
			/>
		</Panel>
	);
}

function RegistriesPage() {
	const { data } = useQuery(registriesQuery);
	const external = data?.registries.filter((r) => r.kind !== "local") ?? [];
	const empty = SECTION.empty;
	const add = (
		<Button asChild>
			<Link to="/integrations/registries/new">
				<Plus data-icon="inline-start" />
				Add registry
			</Link>
		</Button>
	);

	return (
		<Page className="max-w-4xl">
			<PageHeader
				title={SECTION.title}
				description={SECTION.description}
				actions={external.length ? add : undefined}
			/>
			{!data ? (
				<div className="overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border">
					<SkeletonRows rows={3} />
				</div>
			) : (
				<div className="grid gap-8">
					<LocalRegistry data={data} />
					{external.length ? (
						<RegistryList data={data} />
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
				</div>
			)}
		</Page>
	);
}
