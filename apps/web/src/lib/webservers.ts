/*
 * Web server presets for the new-service wizard: each is an image service with one config file
 * mount and, except the load balancer, a named volume for static files. The load balancer's
 * config is generated from a small form whose values ride along as the file's first line.
 */

export const webserverKinds = ["nginx", "caddy", "apache", "haproxy"] as const;
export type WebserverKind = (typeof webserverKinds)[number];

export type WebserverDef = {
	label: string;
	description: string;
	image: string;
	/** Brand icon slug for the service. */
	icon: string;
	port: number;
	/** Where the config file is mounted. */
	config: string;
	/** Where the static files volume is mounted; null for the load balancer. */
	docroot: string | null;
	/** CodeMirror legacy mode the editor highlights with. */
	syntax: "nginx" | "shell";
	defaultConfig: string;
};

/** `importedFrom` marker on services created from a preset. */
export const webserverMarker = (kind: WebserverKind) => `webserver:${kind}`;

export function webserverKind(
	importedFrom: string | null | undefined,
): WebserverKind | undefined {
	const k = importedFrom?.match(/^webserver:([a-z]+)$/)?.[1];
	return webserverKinds.find((w) => w === k);
}

const NGINX = `server {
    listen 80;
    listen [::]:80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }

    # Static assets change name when they change, so they can be cached for long.
    location ~* \\.(?:css|js|mjs|woff2?|svg|png|jpe?g|gif|webp|avif|ico)$ {
        expires 30d;
        add_header Cache-Control "public";
        try_files $uri =404;
    }

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;
}
`;

const CADDY = `{
	# LogiStack's proxy terminates TLS in front of this server.
	auto_https off
	admin off
}

:80 {
	root * /srv
	encode zstd gzip
	file_server
}
`;

const APACHE = `ServerRoot "/usr/local/apache2"
Listen 80
ServerName localhost

LoadModule mpm_event_module modules/mod_mpm_event.so
LoadModule authz_core_module modules/mod_authz_core.so
LoadModule unixd_module modules/mod_unixd.so
LoadModule mime_module modules/mod_mime.so
LoadModule dir_module modules/mod_dir.so
LoadModule log_config_module modules/mod_log_config.so
LoadModule headers_module modules/mod_headers.so
LoadModule rewrite_module modules/mod_rewrite.so

User www-data
Group www-data

DocumentRoot "/usr/local/apache2/htdocs"
<Directory "/usr/local/apache2/htdocs">
    Options FollowSymLinks
    AllowOverride All
    Require all granted
</Directory>
DirectoryIndex index.html

TypesConfig conf/mime.types
ErrorLog /proc/self/fd/2
LogLevel warn
LogFormat "%h %l %u %t \\"%r\\" %>s %b" common
CustomLog /proc/self/fd/1 common
`;

export const lbAlgorithms = ["roundrobin", "leastconn"] as const;
export type LbAlgorithm = (typeof lbAlgorithms)[number];

export type LbSettings = {
	/** `host:port`; a host is a service name in the environment, a hostname or an IPv4. */
	targets: string[];
	algorithm: LbAlgorithm;
	/** HTTP path probed on each target; empty checks the TCP port only. */
	healthPath: string;
};

export const LB_DEFAULTS: LbSettings = {
	targets: [],
	algorithm: "roundrobin",
	healthPath: "/",
};

const HOST =
	/^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/** Why a target is not `host:port`, or undefined when it is. */
export function targetIssue(target: string): string | undefined {
	const m = /^(.+):(\d{1,5})$/.exec(target.trim());
	if (!m) return "Use host:port, like web:3000.";
	const port = Number(m[2]);
	if (port < 1 || port > 65535) return "Ports go from 1 to 65535.";
	if (!HOST.test(m[1] ?? "")) return "Not a valid host name.";
	return undefined;
}

export function healthPathIssue(path: string): string | undefined {
	if (!path) return undefined;
	if (!/^\/[\x21-\x7e]*$/.test(path))
		return "Start with / and leave out spaces.";
	return undefined;
}

/** The first problem with the form, or undefined when it can generate a config. */
export function lbIssue(s: LbSettings): string | undefined {
	const targets = s.targets.map((t) => t.trim()).filter(Boolean);
	if (!targets.length) return "Add at least one target.";
	for (const t of targets) {
		const issue = targetIssue(t);
		if (issue) return `${t}: ${issue}`;
	}
	return healthPathIssue(s.healthPath);
}

const MARKER = "# logistack:lb ";

/** HAProxy config for `s`; its first line keeps the settings so the form can read them back. */
export function loadBalancerConfig(s: LbSettings): string {
	const targets = s.targets.map((t) => t.trim()).filter(Boolean);
	const lines = [
		`${MARKER}${JSON.stringify({ ...s, targets })}`,
		"# Generated from the load balancer form. Editing it by hand turns the form off.",
		"global",
		"    log stdout format raw local0",
		"",
		"defaults",
		"    mode http",
		"    log global",
		"    option httplog",
		"    option forwardfor",
		"    timeout connect 5s",
		"    timeout client 60s",
		"    timeout server 60s",
		"",
		"# Docker's embedded DNS, so service names resolve as their tasks move.",
		"resolvers docker",
		"    nameserver dns 127.0.0.11:53",
		"    hold valid 10s",
		"",
		"frontend http",
		"    bind :8080",
		"    default_backend upstreams",
		"",
		"backend upstreams",
		`    balance ${s.algorithm}`,
	];
	if (s.healthPath)
		lines.push(
			`    option httpchk GET ${s.healthPath}`,
			"    http-check expect status 200-399",
		);
	for (const [i, t] of targets.entries())
		lines.push(
			`    server s${i + 1} ${t} check resolvers docker init-addr libc,none`,
		);
	return `${lines.join("\n")}\n`;
}

/**
 * The form values behind `config`, or undefined when the file was not generated by
 * `loadBalancerConfig` or was edited since.
 */
export function readLoadBalancer(config: string): LbSettings | undefined {
	const first = config.split("\n", 1)[0] ?? "";
	if (!first.startsWith(MARKER)) return undefined;
	try {
		const raw = JSON.parse(first.slice(MARKER.length)) as Partial<LbSettings>;
		const s: LbSettings = {
			targets: Array.isArray(raw.targets) ? raw.targets.map(String) : [],
			algorithm: lbAlgorithms.includes(raw.algorithm as LbAlgorithm)
				? (raw.algorithm as LbAlgorithm)
				: "roundrobin",
			healthPath: typeof raw.healthPath === "string" ? raw.healthPath : "",
		};
		return loadBalancerConfig(s) === config ? s : undefined;
	} catch {
		return undefined;
	}
}

export const WEBSERVERS: Record<WebserverKind, WebserverDef> = {
	nginx: {
		label: "Nginx",
		description: "Static sites and SPAs, with caching and gzip.",
		image: "nginx:1.29-alpine",
		icon: "nginx",
		port: 80,
		config: "/etc/nginx/conf.d/default.conf",
		docroot: "/usr/share/nginx/html",
		syntax: "nginx",
		defaultConfig: NGINX,
	},
	caddy: {
		label: "Caddy",
		description: "A short Caddyfile serving files with compression.",
		image: "caddy:2.10-alpine",
		icon: "caddy",
		port: 80,
		config: "/etc/caddy/Caddyfile",
		docroot: "/srv",
		syntax: "shell",
		defaultConfig: CADDY,
	},
	apache: {
		label: "Apache httpd",
		description: "For .htaccess rules and classic hosting setups.",
		image: "httpd:2.4-alpine",
		icon: "apache",
		port: 80,
		config: "/usr/local/apache2/conf/httpd.conf",
		docroot: "/usr/local/apache2/htdocs",
		syntax: "shell",
		defaultConfig: APACHE,
	},
	haproxy: {
		label: "Load balancer",
		description: "HAProxy spreading traffic across services or hosts.",
		image: "haproxy:3.2-alpine",
		icon: "haproxy",
		port: 8080,
		config: "/usr/local/etc/haproxy/haproxy.cfg",
		docroot: null,
		syntax: "shell",
		defaultConfig: loadBalancerConfig(LB_DEFAULTS),
	},
};

/** The mounts a preset is created with. */
export function webserverMounts(kind: WebserverKind, config: string) {
	const def = WEBSERVERS[kind];
	return [
		{ kind: "config" as const, target: def.config, content: config },
		...(def.docroot
			? [{ kind: "volume" as const, target: def.docroot, name: "static" }]
			: []),
	];
}
