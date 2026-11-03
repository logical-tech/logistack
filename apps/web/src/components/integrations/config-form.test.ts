import { expect, test } from "bun:test";
import schemas from "@/lib/api/mock/schemas.json";
import { fieldLabel } from "@/lib/integrations";
import {
	type ConfigSchema,
	initialValues,
	missingFields,
	toConfig,
} from "./config-form";

const email = schemas.notify.email as unknown as ConfigSchema;
const route53 = schemas.dns.route53 as unknown as ConfigSchema;

test("defaults fill the first variant; strings convert to the schema's types", () => {
	const v = initialValues(email);
	expect(v).toEqual({ transport: "smtp", port: "587", secure: "false" });
	expect(
		toConfig(email, {
			...v,
			host: " smtp.example.com ",
			from: "LogiStack <ops@example.com>",
			to: "a@example.com, b@example.com",
			username: "",
		}),
	).toEqual({
		transport: "smtp",
		host: "smtp.example.com",
		port: 587,
		secure: false,
		from: "LogiStack <ops@example.com>",
		to: ["a@example.com", "b@example.com"],
	});
});

test("the discriminator picks the variant, and only its required fields count", () => {
	const resend = { transport: "resend", from: "x@example.com" };
	expect(Object.keys(missingFields(email, resend)).sort()).toEqual([
		"apiKey",
		"to",
	]);
	expect(
		toConfig(email, { ...resend, apiKey: "re_123", host: "ignored" }),
	).toEqual({
		transport: "resend",
		apiKey: "re_123",
		from: "x@example.com",
	});
});

test("a defaulted field is not required; labels read as words", () => {
	expect(Object.keys(missingFields(route53, initialValues(route53)))).toEqual([
		"accessKeyId",
		"secretAccessKey",
	]);
	expect(fieldLabel("secretAccessKey")).toBe("Secret access key");
	expect(fieldLabel("webhookUrl")).toBe("Webhook URL");
	expect(fieldLabel("apiToken")).toBe("API token");
});
