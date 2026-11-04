import {
	HardDrive,
	KeyRound,
	type LucideIcon,
	Package,
	Server,
} from "lucide-react";
import { brandMark } from "@/components/brand-icon";
import type { GitProviderKind, Registry } from "@/lib/api/integrations";
import { cn } from "@/lib/utils";

export const GitHubMark = brandMark("github");
export const GitLabMark = brandMark("gitlab");

type Kind = { label: string; icon: LucideIcon };

export const GIT_KIND: Record<GitProviderKind, Kind> = {
	github: { label: "GitHub", icon: GitHubMark },
	gitlab: { label: "GitLab", icon: GitLabMark },
	gitea: { label: "Gitea", icon: brandMark("gitea") },
	bitbucket: { label: "Bitbucket", icon: brandMark("bitbucket") },
	generic: { label: "SSH remote", icon: KeyRound },
};

export const REGISTRY_KIND: Record<Registry["kind"], Kind> = {
	local: { label: "Local registry", icon: HardDrive },
	ghcr: { label: "GitHub Container Registry", icon: GitHubMark },
	dockerhub: { label: "Docker Hub", icon: brandMark("docker") },
	gitlab: { label: "GitLab registry", icon: GitLabMark },
	generic: { label: "OCI registry", icon: Package },
};

export type S3Provider =
	| "aws"
	| "r2"
	| "b2"
	| "hetzner"
	| "minio"
	| "wasabi"
	| "custom";

export const S3_PROVIDER: Record<S3Provider, Kind> = {
	aws: { label: "Amazon S3", icon: brandMark("aws") },
	r2: { label: "Cloudflare R2", icon: brandMark("cloudflare") },
	b2: { label: "Backblaze B2", icon: brandMark("backblaze") },
	hetzner: { label: "Hetzner Object Storage", icon: brandMark("hetzner") },
	minio: { label: "MinIO", icon: brandMark("minio") },
	wasabi: { label: "Wasabi", icon: brandMark("wasabi") },
	custom: { label: "S3-compatible", icon: Server },
};

/** The provider an endpoint belongs to, by host; MinIO and the rest have no tell-tale host. */
export function s3ProviderOf(endpoint: string): S3Provider {
	let host = endpoint;
	try {
		host = new URL(endpoint).hostname;
	} catch {}
	if (host.endsWith(".amazonaws.com")) return "aws";
	if (host.endsWith(".r2.cloudflarestorage.com")) return "r2";
	if (host.endsWith(".backblazeb2.com")) return "b2";
	if (host.endsWith(".your-objectstorage.com")) return "hetzner";
	if (host.endsWith(".wasabisys.com")) return "wasabi";
	if (host.includes("minio")) return "minio";
	return "custom";
}

export function KindTile({
	icon: Icon,
	className,
}: {
	icon: LucideIcon;
	className?: string;
}) {
	return (
		<span
			className={cn(
				"grid size-8 shrink-0 place-items-center rounded-md bg-muted text-foreground",
				className,
			)}
		>
			<Icon className="size-4" strokeWidth={1.75} aria-hidden />
		</span>
	);
}
