import type {
	PermissionAction,
	PluginManifest,
	PluginPageLocation,
} from "@logistack/contracts";
import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { DataChip } from "@/components/integrations/parts";
import { SourceBadge } from "@/components/plugins/plugin-icon";
import { ACTION_LABELS } from "@/lib/api/access";

export const LOCATION_LABEL: Record<PluginPageLocation, string> = {
	sidebar: "Sidebar page",
	"service-tab": "Tab on services",
	"project-tab": "Tab on projects",
	settings: "Settings page",
};

/** `sha256:4f1c9e7a2b8d` from a digest-pinned ref; the full ref stays in the title. */
export const shortDigest = (image: string) => {
	const at = image.indexOf("@");
	return at === -1 ? image : image.slice(at + 1, at + 20);
};

const PROVIDER_LABEL = {
	dnsProviders: "DNS provider",
	notificationChannels: "Notification channel",
	secretProviders: "Secret provider",
	backupDestinations: "Backup destination",
} as const;

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="px-4 py-3.5">
			<h3 className="mb-2 text-sm font-medium">{title}</h3>
			<dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
				{children}
			</dl>
		</section>
	);
}

function Row({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="contents">
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="min-w-0 break-words">{children}</dd>
		</div>
	);
}

const Chips = ({ items }: { items: string[] }) => (
	<span className="flex flex-wrap gap-1.5">
		{items.map((x) => (
			<DataChip key={x}>{x}</DataChip>
		))}
	</span>
);

/**
 * What a plugin is and what it gets, in plain words: the wizard's Review step and the
 * install's detail page both read it.
 */
export function ManifestSummary({
	manifest: m,
	image,
	devUrl,
	missingPermissions = [],
	source = { indexId: null, verified: false },
}: {
	manifest: PluginManifest;
	image: string | null;
	devUrl: string | null;
	missingPermissions?: string[];
	/** The marketplace index and its review state; no index means Unlisted. */
	source?: { indexId: string | null; verified: boolean };
}) {
	const c = m.contributes;
	const providers = (
		Object.keys(PROVIDER_LABEL) as (keyof typeof PROVIDER_LABEL)[]
	).flatMap((k) => c[k].map((p) => `${p.title} (${PROVIDER_LABEL[k]})`));
	const nothing =
		!c.pages.length && !c.events.length && !c.tools.length && !providers.length;
	return (
		<div className="divide-y rounded-lg bg-card ring-1 ring-border">
			<Section title="Plugin">
				<Row label="Name">
					<span className="inline-flex flex-wrap items-center gap-2">
						{m.name}
						<SourceBadge {...source} />
					</span>
				</Row>
				{m.description && <Row label="Description">{m.description}</Row>}
				<Row label="Author">
					{m.author ? (
						m.author.url ? (
							<a
								href={m.author.url}
								target="_blank"
								rel="noreferrer"
								className="underline decoration-border underline-offset-4 hover:decoration-foreground"
							>
								{m.author.name}
							</a>
						) : (
							m.author.name
						)
					) : (
						<span className="text-muted-foreground">Not stated</span>
					)}
				</Row>
				<Row label="Version">
					<span className="font-mono text-xs">{m.version}</span>
					<span className="text-muted-foreground"> · {m.id}</span>
				</Row>
				<Row label={image ? "Image" : "Runs at"}>
					{image ? (
						<span title={image}>
							<DataChip>{shortDigest(image)}</DataChip>
						</span>
					) : (
						<span className="grid gap-1">
							<DataChip>{devUrl}</DataChip>
							<span className="text-xs text-muted-foreground">
								A dev URL: no container starts here, LogiStack calls the plugin
								where it runs.
							</span>
						</span>
					)}
				</Row>
				{m.license && <Row label="License">{m.license}</Row>}
			</Section>
			<Section title="Contributes">
				{nothing && (
					<Row label="Nothing">
						<span className="text-muted-foreground">
							It runs in the background only.
						</span>
					</Row>
				)}
				{c.pages.length > 0 && (
					<Row label="Pages">
						<ul className="grid gap-0.5">
							{c.pages.map((p) => (
								<li key={p.id}>
									{p.title}
									<span className="text-muted-foreground">
										{" "}
										· {LOCATION_LABEL[p.location]}
										{p.serviceKinds?.length
											? ` (${p.serviceKinds.join(", ")})`
											: ""}
									</span>
								</li>
							))}
						</ul>
					</Row>
				)}
				{c.events.length > 0 && (
					<Row label="Receives events">
						<Chips items={c.events} />
					</Row>
				)}
				{c.tools.length > 0 && (
					<Row label="Agent tools">
						<ul className="grid gap-0.5">
							{c.tools.map((t) => (
								<li key={t.name}>
									<span className="font-mono text-xs">{t.name}</span>
									<span className="text-muted-foreground">
										{" "}
										· {t.description}
										{t.destructive && " Asks for approval."}
									</span>
								</li>
							))}
						</ul>
					</Row>
				)}
				{providers.length > 0 && (
					<Row label="Providers">{providers.join(", ")}</Row>
				)}
			</Section>
			<Section title="Permissions">
				{m.permissions.length === 0 ? (
					<Row label="None">
						<span className="text-muted-foreground">
							Its API token can't read or change anything.
						</span>
					</Row>
				) : (
					m.permissions.map((a) => {
						const missing = missingPermissions.includes(a);
						const label = ACTION_LABELS[a as PermissionAction];
						return (
							<Row key={a} label={label?.label ?? a}>
								<span className={missing ? "text-bad-text" : undefined}>
									{missing && (
										<CircleAlert
											className="mr-1.5 inline size-3.5 -translate-y-px"
											aria-hidden
										/>
									)}
									{label?.description ?? a}
									{missing && " You don't hold this permission."}
								</span>
							</Row>
						);
					})
				)}
				<Row label="Scope">
					<span className="text-muted-foreground">
						The whole organization, through its own service account.
					</span>
				</Row>
			</Section>
			<Section title="Network and resources">
				<Row label="Talks to">
					{m.egress.length ? (
						<span className="grid gap-1.5">
							<Chips items={m.egress} />
							<span className="text-xs text-muted-foreground">
								Only these hosts are reachable: other traffic is refused by the
								egress proxy.
							</span>
						</span>
					) : (
						<span className="text-muted-foreground">No hosts declared</span>
					)}
				</Row>
				<Row label="Reserves">
					{image ? (
						<span className="tabular">
							{m.resources.cpu} CPU · {m.resources.memory.replace(/i$/, "B")}{" "}
							memory
						</span>
					) : (
						<span className="text-muted-foreground">
							Nothing on your servers
						</span>
					)}
				</Row>
			</Section>
		</div>
	);
}
