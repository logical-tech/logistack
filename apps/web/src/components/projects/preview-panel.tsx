import { CircleAlert, ExternalLink, GitPullRequest } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { Environment } from "@/lib/api/types";
import { relativeTime } from "@/lib/format";

type Preview = NonNullable<Environment["preview"]>;

/**
 * What a pull request preview runs at: its pull request and commit, each exposed service's URL
 * (stack services included) and the stacks that could not follow the last commit.
 */
export function PreviewPanel({ preview }: { preview: Preview }) {
	const byService = Object.entries(preview.serviceUrls ?? {});
	const rows = byService.length
		? byService
		: preview.urls.map((u) => [new URL(u).hostname.split(".")[0], u] as const);
	const errors = Object.entries(preview.stackErrors ?? {});
	return (
		<section aria-label="Preview" className="mb-6 flex flex-col gap-3">
			<div className="overflow-hidden rounded-xl bg-card ring-1 ring-border">
				<div className="flex items-start gap-3 border-b px-4 py-3">
					<GitPullRequest
						className="mt-0.5 size-4 shrink-0 text-muted-foreground"
						aria-hidden
					/>
					<div className="min-w-0 flex-1">
						<p className="flex min-w-0 items-baseline gap-2 text-sm">
							{preview.url ? (
								<a
									href={preview.url}
									target="_blank"
									rel="noreferrer"
									className="shrink-0 font-medium tabular-nums underline-offset-4 hover:underline"
								>
									#{preview.number}
								</a>
							) : (
								<span className="shrink-0 font-medium tabular-nums">
									#{preview.number}
								</span>
							)}
							<span className="min-w-0 truncate" title={preview.title}>
								{preview.title}
							</span>
						</p>
						<p className="mt-0.5 truncate text-xs text-muted-foreground">
							<span className="font-mono">{preview.headBranch}</span> at{" "}
							<span className="font-mono">{preview.headSha.slice(0, 7)}</span>
							{" · "}removed{" "}
							<time
								dateTime={preview.expiresAt}
								title={new Date(preview.expiresAt).toLocaleString()}
							>
								{relativeTime(preview.expiresAt)}
							</time>{" "}
							without a new commit
						</p>
					</div>
				</div>
				{rows.length ? (
					<ul className="divide-y">
						{rows.map(([slug, url]) => (
							<li
								key={url}
								className="flex min-w-0 items-center gap-3 px-4 py-2 text-sm"
							>
								<span className="w-20 shrink-0 truncate text-muted-foreground sm:w-32">
									{slug}
								</span>
								<a
									href={url}
									target="_blank"
									rel="noreferrer"
									className="min-w-0 truncate font-mono text-[13px] underline-offset-4 hover:underline"
								>
									{url.replace(/^https:\/\//, "")}
								</a>
								<ExternalLink
									className="size-3.5 shrink-0 text-muted-foreground"
									aria-hidden
								/>
								<CopyButton
									value={url}
									label={`Copy the URL of ${slug}`}
									className="ml-auto"
								/>
							</li>
						))}
					</ul>
				) : (
					<p className="px-4 py-3 text-sm text-pretty text-muted-foreground">
						No service of this preview has a domain.
					</p>
				)}
			</div>
			{errors.length > 0 && (
				<Alert>
					<CircleAlert className="text-warn-text!" aria-hidden />
					<AlertTitle>
						{errors.length === 1
							? "A stack did not follow the last commit"
							: `${errors.length} stacks did not follow the last commit`}
					</AlertTitle>
					<AlertDescription>
						<ul className="space-y-1">
							{errors.map(([name, message]) => (
								<li key={name} className="text-pretty">
									<span className="font-medium text-foreground">{name}</span>:{" "}
									{message}
								</li>
							))}
						</ul>
						<p className="mt-2 text-xs text-pretty">
							The rest of the preview runs. Push a fix to the pull request to
							try again.
						</p>
					</AlertDescription>
				</Alert>
			)}
		</section>
	);
}
