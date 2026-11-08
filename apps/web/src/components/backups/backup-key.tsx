import { useQuery } from "@tanstack/react-query";
import { Download, TriangleAlert } from "lucide-react";
import { CopyField } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { type BackupPolicy, destinationsQuery } from "@/lib/api/backups";

/**
 * The shell command that reads one backup without LogiStack: the AWS CLI and `age` for S3, and
 * for any other destination `age` over the file copied off it. Without a known object it names
 * the policy's folder and leaves the file name to fill in.
 */
export function useDecryptCommand(policy: BackupPolicy, objectKey?: string) {
	const { data: destinations } = useQuery(destinationsQuery);
	const d = destinations?.find((x) => x.id === policy.s3DestinationId);
	const key = objectKey ?? `backups/${policy.id}/<backup>.age`;
	const file = key.split("/").pop() ?? key;
	const out = objectKey ? file.replace(/\.age$/, "") : "backup";
	if (d && d.kind !== "s3")
		return `age -d -i backup-key.txt < "${file}" > "${out}"  # ${file} from ${d.location.replace(/\/$/, "")}/${key}`;
	const bucket = String(d?.settings.bucket ?? "");
	const prefix = String(d?.settings.prefix ?? "").replace(/\/$/, "");
	const root = d
		? `${bucket}/${prefix ? `${prefix}/` : ""}`
		: "<bucket>/<prefix>/";
	const endpoint = d ? ` --endpoint-url ${d.settings.endpoint}` : "";
	return `aws s3 cp "s3://${root}${key}" -${endpoint} | age -d -i backup-key.txt > "${out}"`;
}

function downloadKey(key: string, policyId: string) {
	const url = URL.createObjectURL(
		new Blob([`# LogiStack backup key for policy ${policyId}\n${key}\n`], {
			type: "text/plain",
		}),
	);
	const a = document.createElement("a");
	a.href = url;
	a.download = `logistack-backup-key-${policyId}.txt`;
	a.click();
	URL.revokeObjectURL(url);
}

/** The one time a policy's age key is visible: the key, a file to keep, and how to decrypt without LogiStack. */
export function BackupKeyReveal({
	policy,
	encryptionKey,
}: {
	policy: BackupPolicy;
	encryptionKey: string;
}) {
	const command = useDecryptCommand(policy);
	return (
		<div className="grid gap-5">
			<div className="flex items-start gap-3 rounded-lg bg-warn/10 px-3.5 py-3 text-sm">
				<TriangleAlert
					className="mt-0.5 size-4 shrink-0 text-warn-text"
					aria-hidden
				/>
				<p>
					<span className="font-medium">Save the key now.</span>{" "}
					<span className="text-muted-foreground">
						It is not shown again. LogiStack keeps a sealed copy to restore, but
						if this server is lost, the key is the only way to read these
						backups. Lose both and the backups are gone.
					</span>
				</p>
			</div>
			<div className="grid gap-1.5">
				<div className="flex items-center justify-between gap-3">
					<span className="text-sm font-medium">Backup key</span>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => downloadKey(encryptionKey, policy.id)}
					>
						<Download data-icon="inline-start" />
						Download key file
					</Button>
				</div>
				<CopyField value={encryptionKey} label="Copy backup key" wrap />
			</div>
			<DecryptHelp command={command} />
		</div>
	);
}

export function DecryptHelp({ command }: { command: string }) {
	return (
		<div className="grid gap-1.5">
			<span className="text-sm font-medium">Decrypt without LogiStack</span>
			<CopyField value={command} label="Copy decrypt command" wrap />
			<p className="text-xs text-pretty text-muted-foreground">
				Save the key as <code className="font-mono">backup-key.txt</code>, then
				run this with the{" "}
				<a
					href="https://age-encryption.org"
					target="_blank"
					rel="noreferrer"
					className="underline underline-offset-2 hover:text-foreground"
				>
					age
				</a>{" "}
				CLI and the AWS CLI. Restore the result with the usual tool, such as
				pg_restore or tar.
			</p>
		</div>
	);
}
