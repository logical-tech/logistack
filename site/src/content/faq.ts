/** Rendered on the page and as FAQPage structured data, so both always say the same thing. */
export const faq = [
	{
		q: "What is a self-hosted PaaS?",
		a: "A platform as a service you run on your own servers. You push code or pick an app, and it handles the build, the container, the domain, HTTPS, backups and logs, the way a hosted platform does, but on machines you control and pay for directly.",
	},
	{
		q: "Is LogiStack free?",
		a: "Yes. LogiStack is open source under the Apache 2.0 license, and every feature is in the build you install: SSO, custom roles, the audit log and multi-node clusters included. There is no paid edition. Sponsors fund development.",
	},
	{
		q: "What do I need to run it?",
		a: "One Linux server with Ubuntu 22.04 or later or Debian 12 or later, amd64 or arm64, 2 GB of RAM, 10 GB of free disk and ports 80 and 443 open. The installer sets up Docker and Swarm if they are missing.",
	},
	{
		q: "Can it run my apps across more than one server?",
		a: "Yes. LogiStack runs on Docker Swarm. Add a node from the dashboard and its agent connects back over one outbound WebSocket, so metrics, logs, backups and schedules work on every machine.",
	},
	{
		q: "Which databases can I deploy?",
		a: "Postgres, MySQL, MariaDB, MongoDB, Redis and libSQL in one click, each with a built-in editor for tables, keys and documents, scheduled encrypted backups and restore.",
	},
	{
		q: "Can I move from another self-hosted PaaS?",
		a: "Yes. The importer reads existing projects, env vars and domains, freezes the old setup and moves services one at a time. Each service can be rolled back until you switch the old platform off.",
	},
	{
		q: "Does it work with AI coding agents?",
		a: "LogiStack ships an MCP server that mirrors its REST API, so an agent such as Claude can create services, read logs and deploy with your permissions. Destructive tools ask for confirmation first.",
	},
] as const;
