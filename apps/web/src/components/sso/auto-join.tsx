import { z } from "zod";
import { RoleSelect } from "@/components/access/scope-picker";
import { Field } from "@/components/field";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
	InputGroupText,
} from "@/components/ui/input-group";
import type { WizardApi, WizardStep } from "@/components/wizard/wizard";

export type AutoJoinValues = { domain: string; defaultRole: string };

/** `oidc-k3v9q2`: chosen up front so the IdP can be told the callback URL before saving. */
export const newProviderId = (kind: "oidc" | "saml") =>
	`${kind}-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;

export const domainOf = (email: string | undefined) =>
	email?.split("@")[1]?.toLowerCase() ?? "";

const schema = z.object({
	domain: z
		.string()
		.trim()
		.regex(
			/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i,
			"Enter a domain like company.com, without the @.",
		),
	defaultRole: z.string().min(1, "Pick a role."),
});

/** The wizard step both SSO flows share: email domain and the role it joins with. */
export function autoJoinStep<
	V extends AutoJoinValues & Record<string, unknown>,
>(): WizardStep<V> {
	return {
		id: "auto-join",
		title: "Who joins automatically",
		description:
			"Someone who signs in through this provider with an email at this domain joins the organization with the role below. Existing members keep their role.",
		schema,
		render: (w: WizardApi<V>) => (
			<div className="grid max-w-md gap-5">
				<Field
					id="wz-domain"
					label="Email domain"
					error={w.error("domain")}
					hint="Also picks this provider when someone types their email on the sign-in page."
				>
					<InputGroup>
						<InputGroupAddon>
							<InputGroupText>@</InputGroupText>
						</InputGroupAddon>
						<InputGroupInput
							{...w.bind("domain")}
							autoFocus
							inputMode="url"
							autoCapitalize="none"
							spellCheck={false}
							placeholder="company.com"
						/>
					</InputGroup>
				</Field>
				<Field
					id="wz-role"
					label="Joins as"
					hint="Owner is not offered: an identity provider shouldn't hand out ownership."
				>
					<RoleSelect
						id="wz-role"
						value={String(w.values.defaultRole)}
						onChange={(r) => w.set("defaultRole", r as V["defaultRole"])}
						exclude={["owner"]}
						className="w-full"
					/>
				</Field>
			</div>
		),
	};
}
