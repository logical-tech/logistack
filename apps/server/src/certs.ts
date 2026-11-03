import { z } from "zod";
import { parseJson } from "./events.ts";
import { CERTS_KEY, redisFor } from "./redis.ts";

/** Mirrors `CertSnapshot` in apps/worker/src/certs.ts, which writes it from Caddy's storage. */
const ManagedCert = z.object({
	names: z.array(z.string()),
	issuer: z.string(),
	notBefore: z.string(),
	notAfter: z.string(),
});
const CertSnapshot = z.object({ at: z.string(), certs: z.array(ManagedCert) });
export type ManagedCert = z.infer<typeof ManagedCert>;

/** Certificates Caddy issued and stored; empty until the worker's first pass. */
export async function managedCertificates(
	redisUrl: string,
): Promise<ManagedCert[]> {
	const raw = await redisFor(redisUrl)
		.get(CERTS_KEY)
		.catch(() => null);
	const parsed = CertSnapshot.safeParse(raw ? parseJson(raw) : undefined);
	return parsed.success ? parsed.data.certs : [];
}
