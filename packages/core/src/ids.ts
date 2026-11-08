export const idPrefixes = {
	folder: "fld",
	project: "prj",
	environment: "env",
	service: "svc",
	stack: "stk",
	envVar: "var",
	secret: "sec",
	secretVersion: "sev",
	secretProvider: "ssp",
	mount: "mnt",
	node: "nod",
	nodeToken: "ntk",
	deployment: "dep",
	domain: "dom",
	certificate: "crt",
	dnsProvider: "dns",
	gitProvider: "git",
	registry: "reg",
	sshKey: "ssh",
	s3Destination: "s3d",
	backupPolicy: "bkp",
	backupRun: "bkr",
	schedule: "sch",
	scheduleRun: "scr",
	notificationChannel: "nch",
	notificationRule: "nrl",
	logDrain: "lgd",
	auditLog: "aud",
	roleGrant: "grt",
	event: "evt",
	nodeJoin: "njn",
	metricThreshold: "thr",
	serviceThreshold: "sth",
	instanceUpdate: "upd",
	storageAccessKey: "sak",
	gameEndpoint: "gep",
	cloudflareTunnel: "cft",
	tailscaleNetwork: "tsn",
	tailscalePublication: "tsp",
	migration: "mig",
	migrationItem: "mgi",
	aiProviderKey: "aik",
	aiGatewayKey: "agk",
	aiUsage: "aiu",
	aiBudget: "aib",
	aiBudgetReservation: "air",
	aiAgentConversation: "aac",
	aiAgentMessage: "aam",
	databaseAccess: "dba",
	databaseUpgrade: "dbu",
	monitor: "mon",
	incident: "inc",
	incidentUpdate: "inu",
	maintenanceWindow: "mtw",
	statusPage: "stp",
	patchRun: "pat",
	pluginInstall: "plg",
} as const;

export type IdPrefix = (typeof idPrefixes)[keyof typeof idPrefixes];

// 32 symbols so `byte & 31` is unbiased; Crockford-style, no i/l/o/u.
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const BODY_LENGTH = 24; // 120 bits of entropy

export function newId(prefix: IdPrefix): string {
	const bytes = crypto.getRandomValues(new Uint8Array(BODY_LENGTH));
	let body = "";
	for (const b of bytes) body += ALPHABET[b & 31];
	return `${prefix}_${body}`;
}

const ID_PATTERN = /^[a-z0-9]+_([0-9a-z]+)$/;

export type DockerKind =
	| "svc"
	| "db"
	| "env"
	| "vol"
	| "cfg"
	| "sec"
	| "cft"
	| "tsn"
	| "tsp"
	| "plg";

/** Docker object name derived from an id, never from user input: `dockerName("svc", "svc_ab12") === "ls-svc-ab12"`. */
export function dockerName(kind: DockerKind, id: string): string {
	const body = ID_PATTERN.exec(id)?.[1];
	if (!body) throw new Error(`not a LogiStack id: ${JSON.stringify(id)}`);
	return `ls-${kind}-${body}`;
}
