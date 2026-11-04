import type { Template } from "@logistack/contracts";
import { databaseIcon, imageIcon } from "@logistack/contracts";
import { Box, Database, Globe, Lock } from "lucide-react";
import { BrandIcon } from "@/components/brand-icon";
import { publicRoutes, serviceImage } from "@/lib/templates";

const SOURCE_NAME = { coolify: "Coolify", dokploy: "Dokploy" } as const;

/** An example of the address the server generates when a domain input is left empty. */
export const generatedExample = (service: string, base: string) =>
	`${service}-xxxxxx.${base}`;

/** Step one of the template flow: every service, volume, file and route the deploy creates. */
export function TemplateOverview({
	template: t,
	base,
}: {
	template: Template;
	base: string;
}) {
	const routes = publicRoutes(t);
	const primary = routes.find((r) => r.input.role === "primary");
	return (
		<div className="grid grid-cols-1 gap-6">
			<div className="flex items-start gap-3 rounded-lg bg-muted/60 p-4 dark:bg-muted/40">
				<Globe
					className="mt-0.5 size-4 shrink-0 text-muted-foreground"
					aria-hidden
				/>
				<p className="min-w-0 text-sm text-muted-foreground">
					{primary ? (
						<>
							Opens at a generated address like{" "}
							<span className="font-mono text-foreground break-all">
								https://{generatedExample(primary.service, base)}
							</span>
							, or at your own domain. You choose in the next step.
						</>
					) : (
						"No public address. These services are reachable only from inside the environment."
					)}
				</p>
			</div>

			<section aria-labelledby="tpl-services">
				<h3
					id="tpl-services"
					className="mb-2.5 text-sm font-semibold [font-stretch:100%]"
				>
					{t.services.length === 1
						? "1 service"
						: `${t.services.length} services`}
				</h3>
				<ul className="divide-y overflow-hidden rounded-xl bg-card shadow-card ring-1 ring-border">
					{t.services.map((s) => {
						const route = routes.find((r) => r.service === s.name);
						const Icon = s.kind === "database" ? Database : Box;
						const brand =
							s.kind === "database"
								? databaseIcon[s.engine]
								: imageIcon(s.image);
						return (
							<li key={s.name} className="flex gap-3 px-4 py-3.5">
								<span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-foreground/80">
									{brand ? (
										<BrandIcon slug={brand} />
									) : (
										<Icon className="size-4" strokeWidth={1.75} aria-hidden />
									)}
								</span>
								<div className="grid grid-cols-1 min-w-0 flex-1 gap-1">
									<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
										<span className="text-sm font-medium">{s.name}</span>
										<span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
											{serviceImage(s)}
										</span>
									</div>
									<dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-[7rem_minmax(0,1fr)]">
										{route && (
											<Row label="Public">
												Port <span className="tabular">{route.port}</span>
												{route.input.role === "primary"
													? ", the app's URL"
													: ` at ${route.input.label.toLowerCase()}`}
											</Row>
										)}
										{s.dependsOn.length > 0 && (
											<Row label="Starts after">{s.dependsOn.join(", ")}</Row>
										)}
										{s.volumes.map((v) => (
											<Row key={v.name} label="Volume">
												<span className="font-mono">{v.name}</span> at{" "}
												<span className="font-mono">{v.target}</span>
												{v.readOnly && ", read-only"}
											</Row>
										))}
										{s.files.map((f) => (
											<Row
												key={f.target}
												label={f.secret ? "Secret file" : "File"}
											>
												<span className="inline-flex min-w-0 items-center gap-1 font-mono">
													{f.secret && (
														<Lock className="size-3 shrink-0" aria-hidden />
													)}
													<span className="truncate">{f.target}</span>
												</span>
											</Row>
										))}
									</dl>
								</div>
							</li>
						);
					})}
				</ul>
			</section>

			<p className="text-xs text-muted-foreground">
				Adapted from the {SOURCE_NAME[t.source.kind]} template{" "}
				<span className="font-mono break-all">{t.source.path}</span>, licensed{" "}
				{t.source.license}. Version {t.version}.
			</p>
		</div>
	);
}

function Row({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="contents">
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="min-w-0 text-foreground">{children}</dd>
		</div>
	);
}
