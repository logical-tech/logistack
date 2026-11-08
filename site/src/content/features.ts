/** Every area of the dashboard, as /features/ lists it. Keep each line true to the shipped UI. */
export type Area = {
	id: string;
	title: string;
	intro: string;
	/** Where it lives in the dashboard. */
	where: string;
	items: [title: string, body: string][];
};

export const areas = (templates: number): Area[] => [
	{
		id: "deploy",
		title: "Deploy from Git or an image",
		intro:
			"Connect a repository once. Every push builds an image tagged with its deployment id and rolls it out without downtime.",
		where: "Project › New service",
		items: [
			[
				"Any Git host",
				"GitHub through a GitHub App created in one click, GitLab, Gitea, Bitbucket or any git URL over SSH. Or skip Git and run a container image.",
			],
			[
				"Three ways to build",
				"Your Dockerfile, railpack with no config at all, or a static site served from a folder. Builds run in rootless BuildKit.",
			],
			[
				"amd64 and arm64",
				"Build for either platform or both, with emulation set up from Settings when a node has the other CPU.",
			],
			[
				"Deploy on push",
				"Webhooks are registered for you. Watch paths skip a deploy when a commit touches nothing the service uses.",
			],
			[
				"Rolling updates",
				"The new container starts and passes its health check before the old one stops. Cancel a build or roll back to any earlier deployment.",
			],
			[
				"Live build logs",
				"Clone, build, push and release stream into the deployment page as they happen.",
			],
			[
				"Registries",
				"A built-in registry on your own server, or GHCR, Docker Hub, GitLab and any registry with a login.",
			],
			[
				"Review before apply",
				"Changed settings wait as a pending diff, with secrets withheld, until you deploy them.",
			],
		],
	},
	{
		id: "templates",
		title: "Templates and compose stacks",
		intro: `${templates} apps deploy from the catalog in one click. Anything else with a compose file deploys as a stack.`,
		where: "Project › Templates",
		items: [
			[
				`${templates} templates`,
				"Wikis, analytics, AI tools, media servers, monitoring, finance, automation and more, searchable by name and category.",
			],
			[
				"Secrets generated",
				"Passwords and keys are generated, stored encrypted and never printed in a log. You fill in only what can't be generated.",
			],
			[
				"Paste a compose file",
				"Paste docker-compose.yml and LogiStack turns each service into one it manages, with volumes and an internal network.",
			],
			[
				"Compose from Git",
				"Point a stack at a compose file in a repository and it redeploys when the file changes.",
			],
		],
	},
	{
		id: "services",
		title: "Run and inspect every service",
		intro:
			"Each service has its own page with the tools you would otherwise SSH in for.",
		where: "Project › Service",
		items: [
			[
				"Logs",
				"Live and historical logs from every replica, with search and stdout and stderr told apart.",
			],
			[
				"Terminal",
				"A shell inside the running container, in the browser, without SSH access to the node.",
			],
			[
				"Files",
				"Browse volumes and the container's filesystem, edit config files, upload and download.",
			],
			[
				"Metrics",
				"CPU, memory, network and disk per service and per container, with thresholds that raise alerts.",
			],
			[
				"Environment variables",
				"Set them for the organization, project, environment or service; the more specific one wins. Secrets stay write-only.",
			],
			[
				"Resources",
				"CPU and memory limits per service, or a resource profile the organization defines once.",
			],
			[
				"Start, stop, restart",
				"Desired state is stored, so a stopped service stays stopped after a reboot or an update.",
			],
		],
	},
	{
		id: "databases",
		title: "Databases with an editor built in",
		intro:
			"Run a managed database in one click and work with its data in the same dashboard, without pgAdmin or a second login.",
		where: "Project › Service › Database",
		items: [
			[
				"Six engines",
				"Postgres, MySQL, MariaDB, MongoDB, Redis and libSQL, each with a version you pick.",
			],
			[
				"Table editor",
				"Browse rows, filter, sort, edit cells and add rows, with the column type shown on every column.",
			],
			[
				"Query console",
				"Run SQL or engine commands, see results as a table, cancel a long query.",
			],
			[
				"Schema",
				"Tables, columns, keys, indexes, views and functions, and the relations drawn as a diagram.",
			],
			[
				"Documents and keys",
				"Browse and edit MongoDB documents and Redis keys of every type.",
			],
			[
				"Roles",
				"Create database users with per-table permissions in a wizard, and rotate their passwords.",
			],
			[
				"Dump and restore",
				"Download a dump or restore one into the database from the browser.",
			],
		],
	},
	{
		id: "storage",
		title: "S3 storage you host",
		intro:
			"Deploy S3-compatible object storage and manage it like a cloud bucket.",
		where: "Storage",
		items: [
			[
				"Bucket browser",
				"Buckets and folders, upload by drag and drop, preview, copy, bulk delete.",
			],
			[
				"Share links",
				"A link to one object that expires, without making the bucket public.",
			],
			[
				"Access keys",
				"Keys scoped to the buckets and actions you choose, revoked in one click.",
			],
			[
				"Backup target",
				"Use a bucket as a backup destination for the rest of your services.",
			],
		],
	},
	{
		id: "backups",
		title: "Backups you can restore",
		intro:
			"A backup counts only if it restores. LogiStack schedules both and tells you when either fails.",
		where: "Service › Backups",
		items: [
			[
				"Databases and volumes",
				"Dumps of every engine and archives of any volume, on a cron schedule in your timezone.",
			],
			[
				"Any S3 destination",
				"Cloudflare R2, Backblaze B2, AWS S3, MinIO or the storage LogiStack hosts.",
			],
			[
				"Encrypted with your key",
				"Files are encrypted before they leave the server. The dashboard shows the command to decrypt one by hand.",
			],
			[
				"Retention",
				"Keep the newest N, anything younger than N days, or both.",
			],
			[
				"Restore checks",
				"A scheduled job restores the latest backup into a throwaway container and reports whether it worked.",
			],
			[
				"One-step restore",
				"Restore into the same service or a fresh one, from any run in the history.",
			],
		],
	},
	{
		id: "domains",
		title: "Domains, HTTPS and DNS",
		intro:
			"Caddy serves every domain with a certificate it renews itself. LogiStack can also write the DNS records for you.",
		where: "Domains · Integrations › DNS",
		items: [
			[
				"Automatic HTTPS",
				"Let's Encrypt over HTTP-01 or DNS-01, wildcard certificates, or your own certificate.",
			],
			[
				"DNS providers",
				"Cloudflare, Route 53 and Hetzner. Browse zones and edit records from the dashboard; records for new domains are created for you.",
			],
			[
				"Cloudflare origin certificates",
				"Issue a Cloudflare Origin CA certificate for proxied domains and check it end to end.",
			],
			[
				"Cloudflare Tunnels",
				"Publish a service through a tunnel, with no inbound port open on the server.",
			],
			[
				"Access rules",
				"Protect a domain with basic auth, an IP allow list or forward auth to your own login service.",
			],
			[
				"Redirects and generated domains",
				"Redirect www to the apex, or get a generated hostname to try a service before it has a name.",
			],
		],
	},
	{
		id: "environments",
		title: "Projects, environments and previews",
		intro:
			"Group services into projects, run each project in several environments, and give every pull request its own copy.",
		where: "Projects",
		items: [
			[
				"Environments",
				"Production, staging and any other you add, each with its own variables and colour.",
			],
			[
				"Preview environments",
				"A pull request gets its own environment and URL, with the commit status on GitHub. It is removed when the branch merges.",
			],
			["Folders", "Organize projects in folders and grant access per folder."],
			[
				"Manifests",
				"Export a project as YAML, keep it in Git and apply it from CI. Secrets are never exported.",
			],
			[
				"Usage",
				"CPU, memory and storage per project, so you know what each one costs to run.",
			],
		],
	},
	{
		id: "servers",
		title: "Servers and monitoring",
		intro:
			"Add servers from the dashboard. An agent on each one reports metrics, logs and container health over one outbound connection.",
		where: "Monitoring",
		items: [
			[
				"Add a node over SSH",
				"A wizard checks the server, installs Docker and joins it to the Swarm. Or copy one command and run it yourself.",
			],
			[
				"Host metrics",
				"CPU, memory, disk and network for every node, with history.",
			],
			[
				"Alerts",
				"Rules on nodes and services, sent to any notification channel when they fire and when they resolve.",
			],
			[
				"Network map",
				"Every service, the networks it joins and the ports it publishes, on one diagram.",
			],
			[
				"Maintenance",
				"Drain a node before work on it, prune unused images, see disk use by directory.",
			],
		],
	},
	{
		id: "schedules",
		title: "Scheduled jobs",
		intro:
			"Cron jobs with a history, set up in a wizard that shows the next runs.",
		where: "Schedules",
		items: [
			[
				"Three places to run",
				"In a fresh container, inside an existing service, or on a node.",
			],
			[
				"Timezone aware",
				"Write the cron expression in plain fields and see the next five runs in your timezone.",
			],
			[
				"Run history",
				"The output and exit code of every run, and a button to run it now.",
			],
		],
	},
	{
		id: "games",
		title: "Game and voice servers",
		intro:
			"Game servers get their own wizard and a panel to run them, with the ports and DNS records players need.",
		where: "Project › New service › Game server",
		items: [
			[
				"Minecraft Java",
				"Vanilla, Paper, Fabric, Forge or NeoForge, with an RCON console and optional Bedrock players through Geyser.",
			],
			["Minecraft Bedrock", "For consoles, phones and Windows."],
			[
				"Counter-Strike 2",
				"A dedicated server through SteamCMD, with RCON and game modes.",
			],
			[
				"TeamSpeak 3 and Mumble",
				"Voice servers with admin keys shown once and stored encrypted.",
			],
			[
				"A hostname for players",
				"The A and SRV records are written to your DNS provider, so players connect by name.",
			],
		],
	},
	{
		id: "notifications",
		title: "Notifications",
		intro:
			"Hear about failed deployments, backups and alerts where your team already is.",
		where: "Integrations › Notifications",
		items: [
			[
				"Ten channels",
				"Email, Slack, Discord, Telegram, Microsoft Teams, Mattermost, ntfy, Gotify, Pushover and webhooks.",
			],
			[
				"Rules",
				"Route each kind of event to the channels that should get it, and send a test from the wizard.",
			],
		],
	},
	{
		id: "access",
		title: "Teams and access",
		intro:
			"Bring your team, decide who touches what, and keep a record of every change.",
		where: "Settings",
		items: [
			[
				"Organizations",
				"Separate organizations on one install, each with its own members, projects and integrations.",
			],
			[
				"Roles per scope",
				"Built-in roles or your own, granted on the organization, a folder, a project or an environment.",
			],
			[
				"Single sign-on",
				"OIDC and SAML, with a test sign-in before you switch it on.",
			],
			[
				"Passkeys and two-factor",
				"Passkeys and TOTP for every user, and a policy that requires them.",
			],
			[
				"Audit log",
				"Every write with its actor, outcome and a diff with secrets redacted. Filter it and export it.",
			],
		],
	},
	{
		id: "automation",
		title: "API, MCP and automation",
		intro:
			"Everything the dashboard does, a script or an AI agent can do too, with the same permissions.",
		where: "Settings › API keys",
		items: [
			[
				"REST API",
				"Documented with OpenAPI, covering every page of the dashboard.",
			],
			[
				"Scoped API keys",
				"Keys limited to projects and actions, with an expiry, rotated in place.",
			],
			[
				"Service accounts",
				"Machine users for CI that don't belong to a person.",
			],
			[
				"MCP server",
				"Connect Claude, Cursor or any MCP client at /mcp and let it deploy, read logs and query databases. Destructive tools ask for confirmation.",
			],
		],
	},
	{
		id: "migrate",
		title: "Moving in and staying current",
		intro:
			"Come from another PaaS without a weekend of downtime, then update from the dashboard.",
		where: "Settings › Migrate · Settings › Updates",
		items: [
			[
				"From Dokploy and Coolify",
				"LogiStack reads the existing install and moves services, databases, domains and variables one by one, with rollback for each.",
			],
			[
				"Updates",
				"Read the changelog of every release an update crosses, breaking changes first, then update in one click. Choose the stable, beta or nightly channel.",
			],
			[
				"Light and dark",
				"The dashboard follows your system theme, and every page works from the keyboard.",
			],
		],
	},
];
