const url = process.env.NEXT_PUBLIC_SITE_URL ?? "https://stack.logicaltech.it";

/** Facts the page repeats. Change them here, never inline. */
export const site = {
	name: "LogiStack",
	url,
	title: "LogiStack: the open-source, self-hosted PaaS",
	description:
		"LogiStack is an open-source, self-hosted PaaS on Docker Swarm. Deploy from Git or one of 500+ templates, get HTTPS, backups, a database editor, S3 storage and metrics for every server. Free, Apache 2.0.",
	/** Served by the site itself: site/Dockerfile copies install/install.sh to /install.sh. */
	install: `curl -fsSL ${url}/install.sh | sudo bash`,
	github: "https://github.com/logical-tech/logistack",
	docs: "/docs/",
	company: { name: "Logical", url: "https://logicaltech.it", country: "IT" },
	license: "Apache-2.0",
} as const;
