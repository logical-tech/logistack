import {
	decrypt,
	deriveSecretsKek,
	encrypt,
	importMasterKey,
	rewrapDataKey,
	unwrapDataKey,
} from "@logistack/core";
import {
	aiProviderKey,
	backupPolicy,
	certificate,
	cloudflareTunnel,
	type Db,
	deployment,
	dnsProvider,
	envVar,
	gitProvider,
	instanceSettings,
	logDrain,
	migrationItem,
	mount,
	notificationChannel,
	project,
	registry,
	s3Destination,
	secret,
	secretKey,
	secretProvider,
	sshKey,
	stack,
	tailscaleNetwork,
} from "@logistack/db";
import { and, eq, getTableColumns, like } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";

type Column = {
	table: PgTable;
	id: AnyPgColumn;
	value: AnyPgColumn;
	/** The column's property name, which `update().set()` takes. */
	field: string;
};
const col = (
	table: PgTable & { id: AnyPgColumn },
	value: AnyPgColumn,
): Column => {
	const field = Object.entries(getTableColumns(table)).find(
		([, c]) => c === value,
	)?.[0];
	if (!field) throw new Error(`${value.name} is not a column of its table`);
	return { table, id: table.id, value, field };
};

/** Every column holding a v1 ciphertext under the raw master key. A new one must be added here. */
export const v1Columns: Column[] = [
	col(gitProvider, gitProvider.configEncrypted),
	col(registry, registry.passwordEncrypted),
	col(sshKey, sshKey.privateKeyEncrypted),
	col(s3Destination, s3Destination.secretEncrypted),
	col(migrationItem, migrationItem.planEncrypted),
	col(backupPolicy, backupPolicy.encryptionKeyEncrypted),
	col(notificationChannel, notificationChannel.configEncrypted),
	col(logDrain, logDrain.configEncrypted),
	col(secretProvider, secretProvider.configEncrypted),
	col(secret, secret.externalFingerprint),
	col(certificate, certificate.keyPemEncrypted),
	col(dnsProvider, dnsProvider.credentialsEncrypted),
	col(cloudflareTunnel, cloudflareTunnel.tokenEncrypted),
	col(tailscaleNetwork, tailscaleNetwork.authKeyEncrypted),
	col(project, project.previewSettingsEncrypted),
	col(stack, stack.composeYamlEncrypted),
	col(envVar, envVar.valueEncrypted),
	col(mount, mount.contentEncrypted),
	col(aiProviderKey, aiProviderKey.secretEncrypted),
	col(deployment, deployment.specSnapshotEncrypted),
	col(instanceSettings, instanceSettings.caddyStorageKeyEncrypted),
];

const opens = async (key: CryptoKey, payload: string) =>
	decrypt(key, payload).then(
		() => true,
		() => false,
	);

/**
 * Re-encrypts everything sealed under `previous` to `current`: every v1 column, then every
 * organization data key (re-wrapped under the new KEK; secret values themselves stay as they
 * are). Idempotent and safe to run concurrently: a value that already opens with the new key is
 * skipped, and each write only lands if the row still holds what was read.
 */
export async function rotateMasterKey(
	db: Db,
	currentBase64: string,
	previousBase64: string,
) {
	// Fresh keys with no fallback: "opens with the new key" must mean exactly that.
	const current = await importMasterKey(currentBase64);
	const previous = await importMasterKey(previousBase64);
	let values = 0;
	let unreadable = 0;
	for (const c of v1Columns) {
		const rows = (await db
			.select({ id: c.id, value: c.value })
			.from(c.table)
			.where(like(c.value, "v1:%"))) as { id: string; value: string }[];
		for (const r of rows) {
			if (await opens(current, r.value)) continue;
			let plain: string;
			try {
				plain = await decrypt(previous, r.value);
			} catch {
				unreadable++;
				continue;
			}
			await db
				.update(c.table)
				.set({ [c.field]: await encrypt(current, plain) })
				.where(and(eq(c.id, r.id), eq(c.value, r.value)));
			values++;
		}
	}
	const kek = await deriveSecretsKek(currentBase64);
	const oldKek = await deriveSecretsKek(previousBase64);
	let dataKeys = 0;
	for (const k of await db.select().from(secretKey)) {
		const ok = await unwrapDataKey(
			kek,
			k.organizationId,
			k.version,
			k.wrappedKey,
		).then(
			() => true,
			() => false,
		);
		if (ok) continue;
		let wrapped: string;
		try {
			wrapped = await rewrapDataKey(
				oldKek,
				kek,
				k.organizationId,
				k.version,
				k.wrappedKey,
			);
		} catch {
			unreadable++;
			continue;
		}
		await db
			.update(secretKey)
			.set({ wrappedKey: wrapped })
			.where(
				and(
					eq(secretKey.organizationId, k.organizationId),
					eq(secretKey.version, k.version),
					eq(secretKey.wrappedKey, k.wrappedKey),
				),
			);
		dataKeys++;
	}
	return { values, dataKeys, unreadable };
}
