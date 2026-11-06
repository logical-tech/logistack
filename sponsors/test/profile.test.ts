import { expect, test } from "bun:test";
import { readProfile } from "../src/profile.ts";

const f = (name: string, website: string, instance: string) => [
	{ key: "sponsorname", text: { value: name } },
	{ key: "website", text: { value: website } },
	{ key: "instance", text: { value: instance } },
];

test("cleans what a sponsor types and drops what isn't safe to publish", () => {
	expect(
		readProfile(
			f("Acme  Inc", "acme.com/about?x=1#y", "http://1.2.3.4.sslip.io/x"),
		),
	).toEqual({
		name: "Acme Inc",
		website: "https://acme.com/about",
		instance: "http://1.2.3.4.sslip.io",
	});
	expect(readProfile(f("", "http://acme.com", "javascript:alert(1)"))).toEqual({
		name: null,
		website: null,
		instance: null,
	});
	expect(
		readProfile(f("x".repeat(61), "https://user:pw@acme.com", "nohost")),
	).toEqual({
		name: null,
		website: null,
		instance: null,
	});
	expect(readProfile(null)).toEqual({
		name: null,
		website: null,
		instance: null,
	});
});
