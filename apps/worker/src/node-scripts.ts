import type { NodeRole, PreflightCheck } from "@logistack/contracts";

/** POSIX single-quote quoting for values we embed in a script sent on stdin. */
export const shq = (v: string) => `'${v.replaceAll("'", `'"'"'`)}'`;

const PRIV = `SUDO=""; if [ "$(id -u)" != 0 ]; then SUDO="sudo -n"; fi`;

export const TEST_SCRIPT = `${PRIV}
echo "user=$(id -un)"
echo "system=$(uname -sm)"
if [ "$(id -u)" = 0 ]; then echo "privileges=root"
elif sudo -n true 2>/dev/null; then echo "privileges=sudo"
else echo "privileges=none"; fi
`;

/** Prints `key=value` lines read by `parsePreflight`. Read-only: changes nothing on the host. */
export function preflightScript(manager: { host: string; port: number }) {
	return `${PRIV}
MANAGER_HOST=${shq(manager.host)}
MANAGER_PORT=${shq(String(manager.port))}
if [ -r /etc/os-release ]; then . /etc/os-release; fi
echo "os=\${PRETTY_NAME:-$(uname -s)}"
echo "os_id=\${ID:-unknown}"
echo "arch=$(uname -m)"
echo "mem_kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null)"
echo "disk_kb=$(df -Pk / 2>/dev/null | awk 'NR==2 {print $4}')"
echo "cpus=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null)"
if [ "$(id -u)" = 0 ]; then echo "privileges=root"
elif sudo -n true 2>/dev/null; then echo "privileges=sudo"
else echo "privileges=none"; fi
if command -v docker >/dev/null 2>&1; then
	echo "docker=$($SUDO docker version --format '{{.Server.Version}}' 2>/dev/null || echo installed)"
	echo "swarm=$($SUDO docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null)"
else
	echo "docker="
	echo "swarm=inactive"
fi
for p in 2377 7946; do
	if command -v ss >/dev/null 2>&1; then
		if ss -Hltn "sport = :$p" 2>/dev/null | grep -q .; then echo "port_$p=busy"; else echo "port_$p=free"; fi
	else echo "port_$p=unknown"; fi
done
if command -v nc >/dev/null 2>&1; then
	if nc -z -w 5 "$MANAGER_HOST" "$MANAGER_PORT" >/dev/null 2>&1; then echo "manager=reachable"; else echo "manager=unreachable"; fi
elif command -v bash >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1; then
	if timeout 5 bash -c 'exec 3<>"/dev/tcp/$0/$1"' "$MANAGER_HOST" "$MANAGER_PORT" 2>/dev/null; then echo "manager=reachable"; else echo "manager=unreachable"; fi
else echo "manager=unknown"; fi
`;
}

/**
 * Idempotent: installs Docker only when missing and joins only when the host is not already in a
 * swarm. The join token is a secret, so it travels inside this stdin script, never in argv here.
 * Prints `LS_NODE_ID=<swarm node id>` last.
 */
export function bootstrapScript(input: {
	token: string;
	manager: string;
	role: NodeRole;
}) {
	return `set -eu
${PRIV}
TOKEN=${shq(input.token)}
MANAGER=${shq(input.manager)}
ROLE=${shq(input.role)}
if ! command -v docker >/dev/null 2>&1; then
	echo "Docker is missing; installing it with get.docker.com"
	if command -v curl >/dev/null 2>&1; then curl -fsSL https://get.docker.com -o /tmp/ls-get-docker.sh
	else wget -qO /tmp/ls-get-docker.sh https://get.docker.com; fi
	$SUDO sh /tmp/ls-get-docker.sh
	rm -f /tmp/ls-get-docker.sh
else
	echo "Docker $($SUDO docker version --format '{{.Server.Version}}') is installed"
fi
if command -v systemctl >/dev/null 2>&1; then $SUDO systemctl enable --now docker >/dev/null 2>&1 || true; fi
STATE=$($SUDO docker info --format '{{.Swarm.LocalNodeState}}')
if [ "$STATE" = active ]; then
	echo "Already part of a swarm; leaving membership as it is"
else
	echo "Joining the swarm at $MANAGER as a $ROLE"
	$SUDO docker swarm join --token "$TOKEN" "$MANAGER"
fi
echo "LS_NODE_ID=$($SUDO docker info --format '{{.Swarm.NodeID}}')"
`;
}

/** Best effort: drops the node out of the swarm before it is removed from the manager. */
export const LEAVE_SCRIPT = `${PRIV}
$SUDO docker swarm leave --force 2>&1 || true
`;

export function parseKv(out: string): Record<string, string> {
	const kv: Record<string, string> = {};
	for (const line of out.split("\n")) {
		const i = line.indexOf("=");
		if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
	}
	return kv;
}

const SUPPORTED_OS = new Set([
	"ubuntu",
	"debian",
	"raspbian",
	"centos",
	"rhel",
	"rocky",
	"almalinux",
	"fedora",
	"sles",
]);
const GiB = 1024 * 1024;

/** Turns the preflight script's output into wizard checks; `fail` blocks the bootstrap step. */
export function parsePreflight(out: string): PreflightCheck[] {
	const kv = parseKv(out);
	const memKb = Number(kv.mem_kb) || 0;
	const diskKb = Number(kv.disk_kb) || 0;
	const checks: PreflightCheck[] = [];
	const add = (
		id: string,
		label: string,
		status: PreflightCheck["status"],
		detail: string,
	) => checks.push({ id, label, status, detail });

	add(
		"os",
		"Operating system",
		SUPPORTED_OS.has(kv.os_id ?? "") ? "ok" : "warn",
		SUPPORTED_OS.has(kv.os_id ?? "")
			? (kv.os ?? "")
			: `${kv.os ?? "unknown"} is not supported by the Docker install script; install Docker yourself first`,
	);
	add(
		"arch",
		"Architecture",
		["x86_64", "aarch64", "arm64"].includes(kv.arch ?? "") ? "ok" : "warn",
		kv.arch || "unknown",
	);
	add(
		"memory",
		"Memory",
		memKb >= 1.8 * GiB ? "ok" : memKb >= 0.9 * GiB ? "warn" : "fail",
		memKb
			? `${(memKb / GiB).toFixed(1)} GiB${memKb < 1.8 * GiB ? " (2 GiB or more recommended)" : ""}`
			: "unknown",
	);
	add(
		"disk",
		"Free disk on /",
		diskKb >= 20 * GiB ? "ok" : diskKb >= 5 * GiB ? "warn" : "fail",
		diskKb
			? `${(diskKb / GiB).toFixed(1)} GiB free${diskKb < 20 * GiB ? " (20 GiB or more recommended)" : ""}`
			: "unknown",
	);
	add(
		"privileges",
		"Root access",
		kv.privileges === "root" || kv.privileges === "sudo" ? "ok" : "fail",
		kv.privileges === "root"
			? "Connected as root"
			: kv.privileges === "sudo"
				? "Passwordless sudo"
				: "The user needs root or passwordless sudo",
	);
	add(
		"docker",
		"Docker",
		"ok",
		kv.docker ? `Docker ${kv.docker} is installed` : "Will be installed",
	);
	add(
		"swarm",
		"Swarm membership",
		kv.swarm === "active" ? "warn" : "ok",
		kv.swarm === "active"
			? "Already in a swarm; joining will be skipped"
			: "Not in a swarm",
	);
	for (const p of ["2377", "7946"])
		add(
			`port_${p}`,
			`Port ${p}`,
			kv[`port_${p}`] === "busy"
				? "warn"
				: kv[`port_${p}`] === "free"
					? "ok"
					: "warn",
			kv[`port_${p}`] === "busy"
				? "Something already listens here"
				: kv[`port_${p}`] === "free"
					? "Free"
					: "Could not check (no ss)",
		);
	add(
		"manager",
		"Reaches the manager on 2377/tcp",
		kv.manager === "reachable"
			? "ok"
			: kv.manager === "unreachable"
				? "fail"
				: "warn",
		kv.manager === "reachable"
			? "Reachable"
			: kv.manager === "unreachable"
				? "Blocked: open 2377/tcp from this server to the manager"
				: "Could not check (no nc or bash)",
	);
	add(
		"overlay",
		"Overlay ports 7946 and 4789/udp",
		"warn",
		"Not testable over SSH: allow 7946/tcp+udp and 4789/udp between all nodes",
	);
	return checks;
}
