import { hmacSha256, sha256Hex } from "./http.ts";

export type AwsCredentials = {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
};

export type SignInput = {
	method: string;
	url: string;
	headers?: Record<string, string>;
	body?: string;
};

export type SignOptions = {
	credentials: AwsCredentials;
	region: string;
	service: string;
	now?: Date;
};

// RFC 3986 unreserved characters stay; everything else is percent-encoded, as SigV4 requires.
const encode = (s: string) =>
	encodeURIComponent(s).replace(
		/[!'()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
	);

/**
 * AWS Signature Version 4 over WebCrypto. Returns the headers to add to the request
 * (`authorization`, `x-amz-date`, and `x-amz-security-token` for session credentials).
 * shortcut: the path is used as the URL already encodes it, which is exact for the
 * alphanumeric paths Route53 and S3 bucket calls use; double-encode segments for other services.
 */
export async function signV4(
	req: SignInput,
	opts: SignOptions,
): Promise<Record<string, string>> {
	const url = new URL(req.url);
	const amzDate = (opts.now ?? new Date())
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}/, "");
	const date = amzDate.slice(0, 8);
	const added: Record<string, string> = { "x-amz-date": amzDate };
	if (opts.credentials.sessionToken)
		added["x-amz-security-token"] = opts.credentials.sessionToken;

	const headers = new Map<string, string>([["host", url.host]]);
	for (const [k, v] of Object.entries({ ...req.headers, ...added }))
		headers.set(k.toLowerCase(), v.trim().replace(/\s+/g, " "));
	const names = [...headers.keys()].sort();
	const signedHeaders = names.join(";");

	const query = [...url.searchParams.entries()]
		.map(([k, v]) => [encode(k), encode(v)] as const)
		.sort(([ak, av], [bk, bv]) =>
			ak === bk ? (av < bv ? -1 : 1) : ak < bk ? -1 : 1,
		)
		.map(([k, v]) => `${k}=${v}`)
		.join("&");

	const canonical = [
		req.method.toUpperCase(),
		url.pathname || "/",
		query,
		names.map((n) => `${n}:${headers.get(n)}\n`).join(""),
		signedHeaders,
		// S3 signs the declared payload hash, which also covers binary and UNSIGNED-PAYLOAD bodies.
		headers.get("x-amz-content-sha256") ?? (await sha256Hex(req.body ?? "")),
	].join("\n");

	const scope = `${date}/${opts.region}/${opts.service}/aws4_request`;
	const stringToSign = [
		"AWS4-HMAC-SHA256",
		amzDate,
		scope,
		await sha256Hex(canonical),
	].join("\n");

	let key = await hmacSha256(`AWS4${opts.credentials.secretAccessKey}`, date);
	for (const part of [opts.region, opts.service, "aws4_request"])
		key = await hmacSha256(key, part);
	const signature = (await hmacSha256(key, stringToSign)).toHex();

	return {
		...added,
		authorization: `AWS4-HMAC-SHA256 Credential=${opts.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
	};
}
