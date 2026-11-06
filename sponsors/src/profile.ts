/**
 * What a sponsor may type on the Stripe payment page, all optional. Name and website go on
 * the public sponsors list, so they are cleaned hard here; the instance URL stays private and
 * only builds the "activate" link in the email.
 */
export type Profile = {
	name: string | null;
	website: string | null;
	instance: string | null;
};

/** Stripe Payment Link custom fields, as checkout.session.completed carries them. */
export type CustomField = {
	key: string;
	text?: { value?: string | null } | null;
};

/** The `key`s of the Payment Link custom fields. */
export const FIELD = {
	name: "sponsorname",
	website: "website",
	instance: "instance",
} as const;

function cleanName(v: string): string | null {
	const s = v
		.replace(/[\p{Cc}\p{Cf}<>]/gu, "")
		.replace(/\s+/g, " ")
		.trim();
	return s && s.length <= 60 ? s : null;
}

function parseUrl(v: string, schemes: string[]): URL | null {
	const raw = v.trim();
	if (!raw || raw.length > 200) return null;
	try {
		const u = new URL(
			/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`,
		);
		const hostOk =
			/^[a-z0-9.-]+$/i.test(u.hostname) &&
			(u.hostname.includes(".") || u.hostname === "localhost");
		if (!schemes.includes(u.protocol) || u.username || u.password || !hostOk)
			return null;
		return u;
	} catch {
		return null;
	}
}

export function readProfile(fields: CustomField[] | null | undefined): Profile {
	const value = (k: string) =>
		fields?.find((f) => f.key === k)?.text?.value ?? "";
	const site = parseUrl(value(FIELD.website), ["https:"]);
	const instance = parseUrl(value(FIELD.instance), ["https:", "http:"]);
	return {
		name: cleanName(value(FIELD.name)),
		// Path kept (a GitHub profile is a fine sponsor link); query and fragment dropped.
		website: site ? `${site.origin}${site.pathname.replace(/\/$/, "")}` : null,
		instance: instance ? instance.origin : null,
	};
}
