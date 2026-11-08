import {
	Activity,
	ArrowRightLeft,
	Bell,
	BotMessageSquare,
	Boxes,
	Cable,
	CalendarClock,
	CircleArrowUp,
	Container,
	Cpu,
	Database,
	FileClock,
	Fingerprint,
	GitBranch,
	Globe,
	HardDrive,
	Heart,
	House,
	KeyRound,
	LockKeyhole,
	type LucideIcon,
	Network,
	Palette,
	Settings2,
	ShieldCheck,
	Sparkles,
	TerminalSquare,
	Users,
	Variable,
	Waypoints,
} from "lucide-react";

/**
 * The one registry of sections: the sidebar, the command palette and the
 * placeholder pages all read it, so a section is added in exactly one place.
 */
export type Section = {
	to: string;
	title: string;
	icon: LucideIcon;
	description: string;
	/** For sections not built yet: the empty state and its primary action. */
	empty?: { title: string; body: string; action: string };
	keywords?: string[];
};

export type NavGroup = { label: string | null; items: Section[] };

export const NAV: NavGroup[] = [
	{
		label: null,
		items: [
			{
				to: "/",
				title: "Home",
				icon: House,
				description: "What is running, what failed, and what needs you.",
			},
			{
				to: "/projects",
				title: "Projects",
				icon: Boxes,
				description: "Folders, projects, environments and their services.",
			},
			{
				to: "/monitoring",
				title: "Monitoring",
				icon: Activity,
				description:
					"CPU, memory, disk and network for every node and container, sampled every 10 seconds.",
				empty: {
					title: "Metrics start with the first agent report",
					body: "Each node runs the LogiStack agent. Once it reports, charts and alert thresholds appear here.",
					action: "Add a server",
				},
				keywords: ["metrics", "cpu", "memory", "nodes"],
			},
			{
				to: "/schedules",
				title: "Schedules",
				icon: CalendarClock,
				description:
					"Cron jobs that run a script in a fresh container, inside a service, or on a host.",
				empty: {
					title: "No schedules yet",
					body: "Run backups, cleanups or reports on a cron. Every run keeps its exit code, duration and output.",
					action: "New schedule",
				},
				keywords: ["cron", "jobs"],
			},
			{
				to: "/domains",
				title: "Domains",
				icon: Globe,
				description:
					"Every hostname the proxy routes, with its certificate and DNS status.",
				empty: {
					title: "Domains you attach to services show up here",
					body: "Use a generated sslip.io hostname to start, or bring your own domain and let a DNS provider create the records.",
					action: "Add domain",
				},
				keywords: ["dns", "tls", "hostnames"],
			},
			{
				to: "/network",
				title: "Network",
				icon: Waypoints,
				description:
					"How traffic reaches each service: the proxy and tunnels, every domain, and the tasks running on each node.",
				empty: {
					title: "Nothing to map yet",
					body: "Services you deploy show up here with their domains, tunnels, published ports and running tasks.",
					action: "Choose a project",
				},
				keywords: ["map", "topology", "graph", "tunnel", "proxy", "ports"],
			},
			{
				to: "/storage",
				title: "Storage",
				icon: HardDrive,
				description:
					"S3-compatible object storage in every project: buckets, files, scoped keys and share links.",
				empty: {
					title: "No object storage yet",
					body: "Add an Object storage service to an environment. MinIO, RustFS, Garage and SeaweedFS run on your own servers.",
					action: "Choose a project",
				},
				keywords: ["s3", "buckets", "minio", "files", "object storage"],
			},
			{
				to: "/agent",
				title: "Agent",
				icon: BotMessageSquare,
				description:
					"Chat with an agent that checks, deploys and changes things through the API, with your permissions. Alpha.",
				keywords: ["chat", "assistant", "ai", "llm", "copilot"],
			},
			{
				to: "/ai",
				title: "AI",
				icon: Sparkles,
				description:
					"One OpenAI- and Anthropic-compatible endpoint over free and paid model providers, with keys and monthly budgets per member.",
				keywords: [
					"llm",
					"gateway",
					"openai",
					"anthropic",
					"models",
					"budget",
					"groq",
				],
			},
		],
	},
	{
		label: "Integrations",
		items: [
			{
				to: "/integrations/git",
				title: "Git providers",
				icon: GitBranch,
				description:
					"GitHub, GitLab, Gitea and Bitbucket for deploy on push and pull request previews.",
				empty: {
					title: "Connect a Git provider",
					body: "Create a GitHub App in two clicks, add an access token for GitLab, Gitea or Bitbucket, or use any host over SSH. Webhooks are always signed.",
					action: "Connect provider",
				},
				keywords: ["github", "gitlab", "repository"],
			},
			{
				to: "/integrations/registries",
				title: "Registries",
				icon: Container,
				description:
					"Where built images are pushed, and where nodes pull them from.",
				empty: {
					title: "No external registries",
					body: "Add GHCR, Docker Hub, GitLab or any OCI registry. Login, push and pull are tested before saving.",
					action: "Add registry",
				},
				keywords: ["docker", "ghcr", "images"],
			},
			{
				to: "/integrations/s3",
				title: "S3 destinations",
				icon: Database,
				description:
					"Buckets for database and volume backups. Any S3-compatible endpoint.",
				empty: {
					title: "Backups need somewhere to go",
					body: "Add AWS S3, Cloudflare R2, Backblaze B2, Hetzner or MinIO. The connection is tested before it's saved.",
					action: "Add destination",
				},
				keywords: ["backup", "r2", "bucket"],
			},
			{
				to: "/integrations/dns",
				title: "DNS providers",
				icon: Network,
				description:
					"Create records automatically and solve DNS-01 challenges for wildcard certificates.",
				empty: {
					title: "No DNS providers connected",
					body: "With Cloudflare, Route 53 or Hetzner connected, new domains get their records and wildcard certificates without manual steps.",
					action: "Connect DNS provider",
				},
				keywords: ["cloudflare", "route53"],
			},
			{
				to: "/integrations/tunnels",
				title: "Cloudflare Tunnels",
				icon: Cable,
				description:
					"Publish services through Cloudflare without opening ports on the server.",
				keywords: ["cloudflared", "homelab", "nat", "zero trust"],
			},
			{
				to: "/integrations/notifications",
				title: "Notifications",
				icon: Bell,
				description:
					"Channels and rules for deployments, backups, certificates and nodes.",
				empty: {
					title: "Nobody hears about failures yet",
					body: "Add Slack, Discord, email, Telegram or a signed webhook, then pick which events reach it.",
					action: "Add channel",
				},
				keywords: ["slack", "email", "alerts"],
			},
			{
				to: "/integrations/secret-providers",
				title: "Secret providers",
				icon: KeyRound,
				description:
					"Read secrets from Vault, Infisical or 1Password at deploy time, without a copy here.",
				empty: {
					title: "No secret providers connected",
					body: "Connect HashiCorp Vault, Infisical or a 1Password Connect server, then reference its secrets with secret://<name>/<path>#<key>.",
					action: "Add provider",
				},
				keywords: ["vault", "infisical", "1password", "hashicorp", "external"],
			},
		],
	},
	{
		label: "Settings",
		items: [
			{
				to: "/settings/general",
				title: "General",
				icon: Settings2,
				description: "Organization name, instance URL and default domains.",
				empty: {
					title: "Instance settings",
					body: "The values you chose during setup live here: the instance URL, generated domains, the Let's Encrypt email and the local registry.",
					action: "Edit settings",
				},
			},
			{
				to: "/settings/variables",
				title: "Secrets & variables",
				icon: Variable,
				description:
					"Encrypted, versioned secrets services can reference, and plain variables every service inherits.",
				keywords: [
					"env",
					"environment",
					"secrets",
					"dotenv",
					"shared",
					"variables",
					"encryption key",
				],
			},
			{
				to: "/settings/appearance",
				title: "Appearance",
				icon: Palette,
				description:
					"Light, dark or system, and a colour theme: LogiStack Default, editor classics or one of the shadcn presets.",
				keywords: ["theme", "dark", "light", "colors", "catppuccin"],
			},
			{
				to: "/settings/members",
				title: "Members",
				icon: Users,
				description: "People with access to this organization and their roles.",
				empty: {
					title: "Only you so far",
					body: "Invite teammates by email and grant them a role on the whole organization or on a single folder or project.",
					action: "Invite member",
				},
				keywords: ["team", "invite", "people"],
			},
			{
				to: "/settings/authentication",
				title: "Authentication",
				icon: LockKeyhole,
				description:
					"Two-factor requirement, and single sign-on through your identity provider over OIDC or SAML.",
				empty: {
					title: "No identity provider yet",
					body: "Connect Okta, Entra ID, Google Workspace, Keycloak or any OIDC or SAML provider. People from your email domain join with the role you choose.",
					action: "Add OIDC provider",
				},
				keywords: [
					"sso",
					"oidc",
					"saml",
					"okta",
					"login",
					"2fa",
					"mfa",
					"two-factor",
				],
			},
			{
				to: "/settings/roles",
				title: "Roles",
				icon: ShieldCheck,
				description:
					"Owner, admin, developer and viewer, plus custom roles scoped from folder to service.",
				empty: {
					title: "Four built-in roles cover most teams",
					body: "Create a custom role when someone needs deploy rights on one project without seeing secrets.",
					action: "Create role",
				},
				keywords: ["permissions", "rbac"],
			},
			{
				to: "/settings/api-keys",
				title: "API keys",
				icon: KeyRound,
				description:
					"Keys for the REST API and the MCP server. Stored hashed, shown once.",
				empty: {
					title: "No API keys",
					body: "Create a key for CI or for an agent. Keys start with lsk_, carry scopes and can expire.",
					action: "Create API key",
				},
				keywords: ["token", "mcp", "ci"],
			},
			{
				to: "/settings/ssh-keys",
				title: "SSH keys",
				icon: TerminalSquare,
				description:
					"For private Git repositories and for bootstrapping new servers.",
				empty: {
					title: "No SSH keys",
					body: "Generate an ed25519 key or import one. Private keys are encrypted at rest.",
					action: "Generate key",
				},
			},
			{
				to: "/settings/certificates",
				title: "Certificates",
				icon: Fingerprint,
				description:
					"Let's Encrypt certificates and the custom ones you upload, with expiry dates.",
				empty: {
					title: "No custom certificates",
					body: "Let's Encrypt covers most domains automatically. Upload a certificate when a client provides their own.",
					action: "Upload certificate",
				},
				keywords: ["tls", "ssl"],
			},
			{
				to: "/settings/updates",
				title: "Updates",
				icon: CircleArrowUp,
				description:
					"The running release, the latest one on GitHub, and one-click updates.",
				empty: {
					title: "Up to date",
					body: "LogiStack checks GitHub for new releases. An admin updates every service from here, api first and worker last, with rollback on failure.",
					action: "Check now",
				},
				keywords: ["upgrade", "version", "release"],
			},
			{
				to: "/settings/sponsor",
				title: "Sponsor",
				icon: Heart,
				description:
					"Sponsor LogiStack, or activate the key from your sponsorship.",
				keywords: ["donate", "donation", "support", "badge", "key"],
			},
			{
				to: "/settings/builds",
				title: "Builds",
				icon: Cpu,
				description:
					"The architectures builds target, what BuildKit can build, and QEMU for the rest.",
				keywords: ["arm64", "amd64", "architecture", "qemu", "buildkit"],
			},
			{
				to: "/settings/migrate",
				title: "Migrate",
				icon: ArrowRightLeft,
				description:
					"Move projects, databases, domains and settings over from Dokploy or Coolify, one service at a time.",
				keywords: ["dokploy", "import", "migration", "coolify"],
			},
			{
				to: "/settings/audit-log",
				title: "Audit log",
				icon: FileClock,
				description:
					"Every change, who made it, from where, and whether it succeeded.",
				empty: {
					title: "Nothing recorded yet",
					body: "Each change made through the UI, the API or MCP is written here with secrets redacted.",
					action: "Export as CSV",
				},
				keywords: ["history", "events"],
			},
		],
	},
];

export const SECTIONS = NAV.flatMap((g) => g.items);

export function section(to: string): Section {
	const s = SECTIONS.find((x) => x.to === to);
	if (!s) throw new Error(`No section registered for ${to}`);
	return s;
}
