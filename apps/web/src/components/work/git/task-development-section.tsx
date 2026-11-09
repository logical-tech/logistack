import type { WorkGitLink, WorkTaskGit } from "@logistack/contracts";
import { Link } from "@tanstack/react-router";
import {
	ArrowUpRight,
	GitBranch,
	GitCommitHorizontal,
	GitMerge,
	GitPullRequest,
	GitPullRequestClosed,
	Rocket,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * "Development" in the task sheet (plan 12.4). Ops readers get every linked commit, branch and
 * pull request plus the release line; work-only actors get counts and nothing that could carry
 * deploy talk. The integrator passes `git` from `GET /tasks/:id`.
 */
export function TaskDevelopmentSection({
	projectId,
	taskKey,
	title,
	git,
}: {
	projectId: string;
	/** `SHOP-42`. */
	taskKey: string;
	title: string;
	git: WorkTaskGit | null;
}) {
	const full = git !== null && "links" in git;
	return (
		<section aria-labelledby="task-development" className="grid gap-2.5">
			<div className="flex min-h-7 items-center justify-between gap-2">
				<h3 id="task-development" className="text-sm font-medium">
					Development
				</h3>
				{full && (
					<div className="flex items-center gap-1">
						<CopyText value={branchName(taskKey, title)} label="Copy branch" />
						<CopyText
							value={`${taskKey}: ${title}`}
							label="Copy commit message"
						/>
					</div>
				)}
			</div>
			{git === null ? (
				<p className="text-sm text-muted-foreground">
					Nothing linked yet. Mention{" "}
					<span className="font-mono">{taskKey}</span> in a branch, commit or
					pull request.
				</p>
			) : "summary" in git ? (
				<p className="text-sm text-muted-foreground">
					{summaryLine(git.summary)}
				</p>
			) : (
				<>
					{git.released && (
						<Link
							to="/projects/$projectId/services/$serviceId/deployments"
							params={{ projectId, serviceId: git.released.serviceId }}
							className="group flex items-center gap-2 rounded-lg bg-ok/10 px-3 py-2 text-sm text-ok-text t-press"
						>
							<Rocket className="size-4" aria-hidden />
							<span>
								In production since{" "}
								<time dateTime={git.released.at}>{since(git.released.at)}</time>
							</span>
							<ArrowUpRight
								className="ml-auto size-3.5 opacity-60 transition-opacity group-hover:opacity-100"
								aria-hidden
							/>
						</Link>
					)}
					<ul className="divide-y rounded-lg ring-1 ring-border">
						{git.links.map((l) => (
							<LinkRow key={l.id} link={l} />
						))}
					</ul>
				</>
			)}
		</section>
	);
}

const KIND = {
	commit: { icon: GitCommitHorizontal, label: "Commit" },
	branch: { icon: GitBranch, label: "Branch" },
	pull_request: { icon: GitPullRequest, label: "Pull request" },
} as const;

const STATE: Record<
	WorkGitLink["state"],
	{ label: string; className: string }
> = {
	open: { label: "Open", className: "text-info-text" },
	merged: { label: "Merged", className: "text-ok-text" },
	closed: { label: "Closed", className: "text-muted-foreground" },
	pushed: { label: "Pushed", className: "text-muted-foreground" },
};

function LinkRow({ link: l }: { link: WorkGitLink }) {
	const Icon =
		l.kind === "pull_request" && l.state === "merged"
			? GitMerge
			: l.kind === "pull_request" && l.state === "closed"
				? GitPullRequestClosed
				: KIND[l.kind].icon;
	const ref =
		l.kind === "commit"
			? l.ref.slice(0, 7)
			: l.kind === "pull_request"
				? `#${l.ref}`
				: l.ref;
	const body = (
		<>
			<Icon
				className={cn("mt-0.5 size-4 shrink-0", STATE[l.state].className)}
				aria-label={KIND[l.kind].label}
			/>
			<span className="min-w-0 flex-1">
				<span className="block truncate text-sm">{l.title ?? ref}</span>
				<span className="block truncate text-xs text-muted-foreground">
					<span className="font-mono">{ref}</span> · {l.repo}
					{l.author ? ` · ${l.author}` : ""}
				</span>
			</span>
			<span className={cn("shrink-0 text-xs", STATE[l.state].className)}>
				{STATE[l.state].label}
			</span>
		</>
	);
	return (
		<li>
			{l.url ? (
				<a
					href={l.url}
					target="_blank"
					rel="noreferrer"
					className="flex items-start gap-2.5 px-3 py-2 transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none"
				>
					{body}
				</a>
			) : (
				<div className="flex items-start gap-2.5 px-3 py-2">{body}</div>
			)}
		</li>
	);
}

/** `shop-42-short-title-slug`. */
export function branchName(taskKey: string, title: string) {
	const slug = title
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/, "");
	return [taskKey.toLowerCase(), slug].filter(Boolean).join("-");
}

/** "1 change in review · 2 merged". */
export function summaryLine(s: {
	pullRequests: { open: number; merged: number };
	commits: number;
}) {
	const parts = [
		s.pullRequests.open &&
			`${s.pullRequests.open} ${s.pullRequests.open === 1 ? "change" : "changes"} in review`,
		s.pullRequests.merged && `${s.pullRequests.merged} merged`,
		!s.pullRequests.open &&
			!s.pullRequests.merged &&
			s.commits &&
			`${s.commits} ${s.commits === 1 ? "commit" : "commits"}`,
	].filter(Boolean);
	return parts.length ? parts.join(" · ") : "No development activity yet.";
}

function since(iso: string) {
	const d = new Date(iso);
	const sameDay = d.toDateString() === new Date().toDateString();
	return d.toLocaleString(
		undefined,
		sameDay
			? { hour: "2-digit", minute: "2-digit" }
			: { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" },
	);
}

function CopyText({ value, label }: { value: string; label: string }) {
	return (
		<Button
			type="button"
			variant="ghost"
			size="sm"
			className="h-7 px-2 text-xs text-muted-foreground"
			title={value}
			onClick={() =>
				navigator.clipboard.writeText(value).then(
					() => toast.success("Copied", { description: value }),
					() => toast.error("Couldn't copy"),
				)
			}
		>
			{label}
		</Button>
	);
}
