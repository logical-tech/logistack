import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { z } from "zod";
import { Field } from "@/components/field";
import type {
	OtherDestination,
	S3Provider,
} from "@/components/integration-kinds";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ChoiceGroup, Instructions } from "@/components/wizard/parts";
import type { WizardApi } from "@/components/wizard/wizard";
import type { DestinationInput } from "@/lib/api/backups";
import { nodesQuery } from "@/lib/api/monitoring";

// The add-destination wizard's steps for every kind that is not S3: rclone remotes (SFTP,
// WebDAV, Azure Blob, Google Drive, native B2) and a folder on a node.

/** A pick on the first step; `b2native` keeps native B2 apart from B2's S3 endpoint. */
export type OtherChoice = Exclude<OtherDestination, "b2"> | "b2native";
export type Choice = S3Provider | OtherChoice;

export const OTHER_CHOICES: OtherChoice[] = [
	"sftp",
	"webdav",
	"azureblob",
	"drive",
	"b2native",
	"local",
];

export const kindOfChoice = (c: OtherChoice): OtherDestination =>
	c === "b2native" ? "b2" : c;
export const isOther = (c: Choice): c is OtherChoice =>
	(OTHER_CHOICES as string[]).includes(c);

/** Answers the non-S3 steps own. Strings throughout, as the wizard's inputs give them. */
export type OtherValues = {
	host: string;
	port: string;
	user: string;
	sftpAuth: "password" | "key";
	password: string;
	privateKey: string;
	url: string;
	vendor: "other" | "nextcloud" | "owncloud";
	account: string;
	accountKey: string;
	container: string;
	driveAuth: "token" | "serviceAccount";
	token: string;
	serviceAccount: string;
	rootFolderId: string;
	b2Bucket: string;
	nodeId: string;
	path: string;
};

export const OTHER_DEFAULTS: OtherValues = {
	host: "",
	port: "22",
	user: "",
	sftpAuth: "password",
	password: "",
	privateKey: "",
	url: "",
	vendor: "other",
	account: "",
	accountKey: "",
	container: "",
	driveAuth: "token",
	token: "",
	serviceAccount: "",
	rootFolderId: "",
	b2Bucket: "",
	nodeId: "",
	path: "",
};

export const OTHER_SECRET_KEYS = [
	"password",
	"privateKey",
	"accountKey",
	"token",
	"serviceAccount",
] as const;

export const OTHER_DESCRIPTION: Record<OtherChoice, string> = {
	sftp: "A NAS, a storage box or any server you can ssh into.",
	webdav: "Nextcloud, ownCloud or any WebDAV share.",
	azureblob: "A container in an Azure storage account.",
	drive: "A folder in My Drive or a Shared Drive.",
	b2native: "Backblaze's own API, for keys made without S3 access.",
	local: "A folder on one of your nodes. Fast, but not off-site.",
};

const trimSlashes = (p: string) => p.trim().replace(/^\/+|\/+$/g, "");

/** What the probe and create take, built from the answers. */
export function otherInput(
	choice: OtherChoice,
	v: OtherValues,
): DestinationInput {
	switch (choice) {
		case "sftp":
			return {
				kind: "sftp",
				settings: {
					host: v.host.trim(),
					port: Number(v.port) || 22,
					user: v.user.trim(),
					path: v.path.trim().replace(/\/+$/, ""),
				},
				secrets:
					v.sftpAuth === "key"
						? { privateKey: v.privateKey }
						: { password: v.password },
			};
		case "webdav":
			return {
				kind: "webdav",
				settings: {
					url: v.url.trim().replace(/\/+$/, ""),
					vendor: v.vendor,
					user: v.user.trim(),
					path: trimSlashes(v.path),
				},
				secrets: v.password ? { password: v.password } : {},
			};
		case "azureblob":
			return {
				kind: "azureblob",
				settings: {
					account: v.account.trim(),
					container: v.container.trim(),
					path: trimSlashes(v.path),
				},
				secrets: { key: v.accountKey.trim() },
			};
		case "drive":
			return {
				kind: "drive",
				settings: {
					rootFolderId: v.rootFolderId.trim(),
					path: trimSlashes(v.path),
				},
				secrets:
					v.driveAuth === "token"
						? { token: v.token.trim() }
						: { serviceAccount: v.serviceAccount.trim() },
			};
		case "b2native":
			return {
				kind: "b2",
				settings: {
					account: v.account.trim(),
					bucket: v.b2Bucket.trim(),
					path: trimSlashes(v.path),
				},
				secrets: { key: v.accountKey.trim() },
			};
		case "local":
			return {
				kind: "local",
				nodeId: v.nodeId,
				settings: { path: v.path.trim().replace(/\/+$/, "") },
				secrets: {},
			};
	}
}

const required = (msg: string) => z.string().trim().min(1, msg);
const folder = z
	.string()
	.trim()
	.max(500, "Keep the path under 500 characters.")
	.refine((p) => !p.split("/").includes(".."), "No .. in the path.");

/** The location step's schema for a kind. */
export function locationSchema(choice: OtherChoice): z.ZodType {
	switch (choice) {
		case "sftp":
			return z.object({
				host: required("Enter the server's hostname or IP."),
				port: z
					.string()
					.trim()
					.regex(/^\d{1,5}$/, "A port from 1 to 65535.")
					.refine(
						(p) => Number(p) >= 1 && Number(p) <= 65535,
						"A port from 1 to 65535.",
					),
				user: required("Enter the user to log in as."),
				path: folder,
			});
		case "webdav":
			return z.object({
				url: z
					.string()
					.trim()
					.pipe(
						z.url({
							protocol: /^https?$/,
							error: "Use the full URL, starting with https://.",
						}),
					),
				path: folder,
			});
		case "azureblob":
			return z.object({
				account: z
					.string()
					.trim()
					.regex(/^[a-z0-9]{3,24}$/, "3 to 24 lowercase letters and digits."),
				container: z
					.string()
					.trim()
					.regex(
						/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/,
						"3 to 63 lowercase letters, digits and dashes.",
					),
				path: folder,
			});
		case "drive":
			return z.object({ path: folder });
		case "b2native":
			return z.object({
				b2Bucket: z
					.string()
					.trim()
					.regex(/^[A-Za-z0-9-]{6,50}$/, "6 to 50 letters, digits and dashes."),
				path: folder,
			});
		case "local":
			return z.object({
				nodeId: required("Pick the node that holds the folder."),
				path: z
					.string()
					.trim()
					.regex(/^\/./, "An absolute path, like /mnt/backups.")
					.refine((p) => !p.split("/").includes(".."), "No .. in the path."),
			});
	}
}

/** The credentials step's schema; `local` has none. */
export function credentialsSchema(
	choice: OtherChoice,
	v: OtherValues,
): z.ZodType {
	switch (choice) {
		case "sftp":
			return v.sftpAuth === "key"
				? z.object({
						privateKey: z
							.string()
							.trim()
							.regex(
								/^-----BEGIN [A-Z ]*PRIVATE KEY-----/,
								"Paste the whole PEM block.",
							),
					})
				: z.object({ password: z.string().min(1, "Enter the password.") });
		case "azureblob":
			return z.object({
				accountKey: required("Paste one of the account's access keys."),
			});
		case "b2native":
			return z.object({
				account: required("Paste the keyID."),
				accountKey: required("Paste the applicationKey."),
			});
		case "drive":
			return v.driveAuth === "token"
				? z.object({
						token: z
							.string()
							.trim()
							.refine(
								(t) => t.startsWith("{"),
								"Paste the JSON rclone printed.",
							),
					})
				: z.object({
						serviceAccount: z
							.string()
							.trim()
							.refine(
								(t) => t.includes('"private_key"'),
								"Paste the key's JSON file.",
							),
					});
		default:
			return z.object({});
	}
}

const mono = {
	autoCapitalize: "none",
	autoComplete: "off",
	spellCheck: false,
	className: "font-mono",
} as const;

function PathField<V extends OtherValues>({
	w,
	hint,
	placeholder,
	label = "Folder",
}: {
	w: WizardApi<V>;
	hint: ReactNode;
	placeholder: string;
	label?: string;
}) {
	return (
		<Field
			id="wz-path"
			label={label}
			optional={label === "Folder"}
			error={w.error("path")}
			hint={hint}
		>
			<Input {...w.bind("path")} placeholder={placeholder} {...mono} />
		</Field>
	);
}

const under = (root: string) => `Backups land under ${root}backups/<policy>/.`;

export function LocationStep<V extends OtherValues & { provider: Choice }>({
	w,
}: {
	w: WizardApi<V>;
}) {
	const v = w.values;
	const nodes = useQuery(nodesQuery);
	switch (v.provider as OtherChoice) {
		case "sftp":
			return (
				<div className="grid gap-5">
					<div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_7rem]">
						<Field id="wz-host" label="Host" error={w.error("host")}>
							<Input
								{...w.bind("host")}
								placeholder="nas.example.com"
								{...mono}
								autoFocus
							/>
						</Field>
						<Field id="wz-port" label="Port" error={w.error("port")}>
							<Input
								{...w.bind("port")}
								inputMode="numeric"
								className="font-mono tabular"
							/>
						</Field>
					</div>
					<Field id="wz-user" label="User" error={w.error("user")}>
						<Input {...w.bind("user")} placeholder="backup" {...mono} />
					</Field>
					<PathField
						w={w}
						placeholder="/volume1/backups"
						hint={`Absolute, or relative to the user's home. ${under(v.path.trim() ? `${v.path.trim().replace(/\/+$/, "")}/` : "~/")}`}
					/>
				</div>
			);
		case "webdav":
			return (
				<div className="grid gap-5">
					<Field
						id="wz-url"
						label="WebDAV URL"
						error={w.error("url")}
						hint="Nextcloud: https://cloud.example.com/remote.php/dav/files/<user>"
					>
						<Input
							{...w.bind("url")}
							placeholder="https://cloud.example.com/remote.php/dav/files/backup"
							inputMode="url"
							{...mono}
							autoFocus
						/>
					</Field>
					<ChoiceGroup
						label="Server"
						columns={4}
						value={v.vendor}
						onChange={(vendor) => w.set("vendor", vendor as V["vendor"])}
						choices={[
							{
								value: "nextcloud",
								title: "Nextcloud",
								description: "Uses its chunked uploads.",
							},
							{
								value: "owncloud",
								title: "ownCloud",
								description: "Uses its checksums.",
							},
							{ value: "other", title: "Other", description: "Plain WebDAV." },
						]}
					/>
					<PathField
						w={w}
						placeholder="LogiStack"
						hint={under(
							v.path.trim() ? `${trimSlashes(v.path)}/` : "the share's root, ",
						)}
					/>
				</div>
			);
		case "azureblob":
			return (
				<div className="grid gap-5">
					<div className="grid gap-5 sm:grid-cols-2">
						<Field
							id="wz-account"
							label="Storage account"
							error={w.error("account")}
						>
							<Input
								{...w.bind("account")}
								placeholder="acmebackups"
								{...mono}
								autoFocus
							/>
						</Field>
						<Field
							id="wz-container"
							label="Container"
							error={w.error("container")}
							hint="Create it first in the portal."
						>
							<Input
								{...w.bind("container")}
								placeholder="logistack"
								{...mono}
							/>
						</Field>
					</div>
					<PathField
						w={w}
						placeholder="prod"
						hint={under(
							`${v.container.trim() || "<container>"}/${v.path.trim() ? `${trimSlashes(v.path)}/` : ""}`,
						)}
					/>
				</div>
			);
		case "drive":
			return (
				<div className="grid gap-5">
					<Field
						id="wz-rootFolderId"
						label="Root folder ID"
						optional
						error={w.error("rootFolderId")}
						hint="The last part of the folder's URL. Empty uses My Drive; a service account needs a folder or Shared Drive shared with it."
					>
						<Input
							{...w.bind("rootFolderId")}
							placeholder="1AbCdEfGhIjKlMnOpQrStUvWxYz"
							{...mono}
							autoFocus
						/>
					</Field>
					<PathField
						w={w}
						placeholder="LogiStack"
						hint={under(
							v.path.trim() ? `${trimSlashes(v.path)}/` : "the root, ",
						)}
					/>
				</div>
			);
		case "b2native":
			return (
				<div className="grid gap-5">
					<Field
						id="wz-b2Bucket"
						label="Bucket"
						error={w.error("b2Bucket")}
						hint="Create it first; private is fine."
					>
						<Input
							{...w.bind("b2Bucket")}
							placeholder="acme-backups"
							{...mono}
							autoFocus
						/>
					</Field>
					<PathField
						w={w}
						placeholder="logistack"
						hint={under(
							`${v.b2Bucket.trim() || "<bucket>"}/${v.path.trim() ? `${trimSlashes(v.path)}/` : ""}`,
						)}
					/>
				</div>
			);
		case "local":
			return (
				<div className="grid gap-5">
					{!nodes.data ? (
						<p className="text-sm text-muted-foreground">Loading nodes…</p>
					) : (
						<ChoiceGroup
							label="Node"
							columns={2}
							value={v.nodeId || undefined}
							invalid={!!w.error("nodeId")}
							onChange={(id) => w.set("nodeId", id as V["nodeId"])}
							choices={nodes.data.map((n) => ({
								value: n.id,
								title: n.hostname,
								description: n.address,
							}))}
						/>
					)}
					{w.error("nodeId") && (
						<p className="text-xs text-bad-text">{w.error("nodeId")}</p>
					)}
					<PathField
						w={w}
						label="Folder on the node"
						placeholder="/mnt/backups"
						hint="It must already exist, and survive reboots: a mounted disk, not /tmp. A node that dies takes these backups with it, so keep an off-site copy too."
					/>
				</div>
			);
	}
}

export function CredentialsStep<V extends OtherValues & { provider: Choice }>({
	w,
}: {
	w: WizardApi<V>;
}) {
	const v = w.values;
	const secretHint = "Encrypted at rest. Never shown again.";
	switch (v.provider as OtherChoice) {
		case "sftp":
			return (
				<div className="grid gap-5">
					<ChoiceGroup
						label="Sign in with"
						value={v.sftpAuth}
						onChange={(a) => w.set("sftpAuth", a as V["sftpAuth"])}
						choices={[
							{
								value: "password",
								title: "Password",
								description: "The user's login password.",
							},
							{
								value: "key",
								title: "Private key",
								description:
									"An unencrypted PEM key; its public half in authorized_keys.",
							},
						]}
					/>
					{v.sftpAuth === "key" ? (
						<Field
							id="wz-privateKey"
							label="Private key"
							error={w.error("privateKey")}
							hint={secretHint}
						>
							<Textarea
								{...w.bind("privateKey")}
								rows={6}
								placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
								{...mono}
								className="font-mono text-xs"
								autoFocus
							/>
						</Field>
					) : (
						<Field
							id="wz-password"
							label="Password"
							error={w.error("password")}
							hint={secretHint}
						>
							<Input
								{...w.bind("password")}
								type="password"
								{...mono}
								autoFocus
							/>
						</Field>
					)}
				</div>
			);
		case "webdav":
			return (
				<div className="grid gap-5">
					<Instructions>
						<p>
							On Nextcloud, make an <strong>app password</strong> under{" "}
							<strong>Settings → Security → Devices &amp; sessions</strong>, so
							the account password never leaves you.
						</p>
					</Instructions>
					<div className="grid gap-5 sm:grid-cols-2">
						<Field id="wz-user" label="User" optional error={w.error("user")}>
							<Input {...w.bind("user")} {...mono} autoFocus />
						</Field>
						<Field
							id="wz-password"
							label="Password"
							optional
							error={w.error("password")}
							hint={secretHint}
						>
							<Input {...w.bind("password")} type="password" {...mono} />
						</Field>
					</div>
				</div>
			);
		case "azureblob":
			return (
				<div className="grid gap-5">
					<Instructions
						href="https://portal.azure.com/#browse/Microsoft.Storage%2FStorageAccounts"
						link="Open storage accounts"
					>
						<p>
							In the storage account, open{" "}
							<strong>Security + networking → Access keys</strong> and copy{" "}
							<strong>key1</strong>.
						</p>
					</Instructions>
					<Field
						id="wz-accountKey"
						label="Access key"
						error={w.error("accountKey")}
						hint={secretHint}
					>
						<Input
							{...w.bind("accountKey")}
							type="password"
							{...mono}
							autoFocus
						/>
					</Field>
				</div>
			);
		case "drive":
			return (
				<div className="grid gap-5">
					<ChoiceGroup
						label="Sign in with"
						value={v.driveAuth}
						onChange={(a) => w.set("driveAuth", a as V["driveAuth"])}
						choices={[
							{
								value: "token",
								title: "Your Google account",
								description:
									"A token from rclone authorize, run on your own machine.",
							},
							{
								value: "serviceAccount",
								title: "Service account",
								description:
									"A JSON key; share the folder or Shared Drive with it.",
							},
						]}
					/>
					{v.driveAuth === "token" ? (
						<>
							<Instructions
								href="https://rclone.org/install/"
								link="Install rclone"
							>
								<p>
									On a computer with a browser, run{" "}
									<code className="font-mono text-xs">
										rclone authorize "drive"
									</code>
									, sign in, and paste the JSON it prints, from{" "}
									<code className="font-mono text-xs">{"{"}</code> to{" "}
									<code className="font-mono text-xs">{"}"}</code>.
								</p>
							</Instructions>
							<Field
								id="wz-token"
								label="Token"
								error={w.error("token")}
								hint={secretHint}
							>
								<Textarea
									{...w.bind("token")}
									rows={4}
									placeholder='{"access_token":"…","refresh_token":"…"}'
									{...mono}
									className="font-mono text-xs"
									autoFocus
								/>
							</Field>
						</>
					) : (
						<Field
							id="wz-serviceAccount"
							label="Service account key"
							error={w.error("serviceAccount")}
							hint={secretHint}
						>
							<Textarea
								{...w.bind("serviceAccount")}
								rows={6}
								placeholder='{"type":"service_account",…}'
								{...mono}
								className="font-mono text-xs"
								autoFocus
							/>
						</Field>
					)}
				</div>
			);
		case "b2native":
			return (
				<div className="grid gap-5">
					<Instructions
						href="https://secure.backblaze.com/app_keys.htm"
						link="Open application keys"
					>
						<p>
							Under{" "}
							<strong>Application Keys → Add a New Application Key</strong>,
							allow <strong>Read and Write</strong> on this bucket only. Deleted
							backups are deleted for real, not hidden as old versions.
						</p>
					</Instructions>
					<div className="grid gap-5 sm:grid-cols-2">
						<Field id="wz-account" label="keyID" error={w.error("account")}>
							<Input {...w.bind("account")} {...mono} autoFocus />
						</Field>
						<Field
							id="wz-accountKey"
							label="applicationKey"
							error={w.error("accountKey")}
							hint={secretHint}
						>
							<Input {...w.bind("accountKey")} type="password" {...mono} />
						</Field>
					</div>
				</div>
			);
		default:
			return null;
	}
}

/** Where the probe writes, for the test step's idle line. */
export function probeWhere(
	choice: OtherChoice,
	v: OtherValues,
	nodeName?: string,
) {
	const p = v.path.trim();
	switch (choice) {
		case "sftp":
			return `${v.host.trim()}:${p || "~"}`;
		case "webdav":
			return `${v.url.trim().replace(/\/+$/, "")}/${trimSlashes(p)}`;
		case "azureblob":
			return `${v.container.trim()}/${trimSlashes(p)}`;
		case "drive":
			return `Drive:/${trimSlashes(p)}`;
		case "b2native":
			return `${v.b2Bucket.trim()}/${trimSlashes(p)}`;
		case "local":
			return `${nodeName ?? "the node"}:${p}`;
	}
}

/** Review rows for the summary. */
export function otherSummary(choice: OtherChoice, v: OtherValues) {
	const code = (s: string) => <span className="font-mono text-xs">{s}</span>;
	const rows: { label: string; value: ReactNode }[] = [];
	switch (choice) {
		case "sftp":
			rows.push(
				{
					label: "Server",
					value: code(`${v.user.trim()}@${v.host.trim()}:${v.port}`),
				},
				{
					label: "Sign-in",
					value:
						v.sftpAuth === "key"
							? "Private key, encrypted on save"
							: "Password, encrypted on save",
				},
			);
			break;
		case "webdav":
			rows.push({ label: "URL", value: code(v.url.trim()) });
			break;
		case "azureblob":
			rows.push({
				label: "Container",
				value: code(`${v.account.trim()}/${v.container.trim()}`),
			});
			break;
		case "drive":
			rows.push({
				label: "Sign-in",
				value:
					v.driveAuth === "token"
						? "OAuth token, encrypted on save"
						: "Service account, encrypted on save",
			});
			break;
		case "b2native":
			rows.push({ label: "Bucket", value: code(v.b2Bucket.trim()) });
			break;
		case "local":
			break;
	}
	rows.push({ label: "Folder", value: code(v.path.trim() || "(root)") });
	return rows;
}
