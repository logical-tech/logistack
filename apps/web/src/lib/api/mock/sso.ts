import { ApiError } from "../adapter";
import type { SsoApi, SsoProvider } from "../sso";

const delay = <T>(value: T, ms = 220 + Math.random() * 380): Promise<T> =>
	new Promise((resolve) =>
		setTimeout(() => resolve(structuredClone(value)), ms),
	);

const providers: SsoProvider[] = [
	{
		providerId: "okta-logical",
		type: "oidc",
		issuer: "https://logical.okta.com",
		domain: "logical.it",
		defaultRole: "developer",
		clientIdLastFour: "9fA2",
	},
];

const base = () => `${location.origin}/api/auth`;

export const ssoMock: SsoApi = {
	status: () => delay({ enabled: providers.length > 0 }),
	list: () => delay(providers),
	async discover(issuer) {
		await delay(null, 700);
		if (issuer.includes("fail"))
			throw new ApiError(
				400,
				`the discovery document at ${issuer}/.well-known/openid-configuration answered 404`,
			);
		const root = issuer.replace(/\/+$/, "");
		return {
			issuer: root,
			authorizationEndpoint: `${root}/oauth2/v1/authorize`,
			tokenEndpoint: `${root}/oauth2/v1/token`,
			userInfoEndpoint: `${root}/oauth2/v1/userinfo`,
			jwksUri: `${root}/oauth2/v1/keys`,
			scopesSupported: [
				"openid",
				"email",
				"profile",
				"groups",
				"offline_access",
			],
			tokenEndpointAuthMethods: ["client_secret_basic", "client_secret_post"],
		};
	},
	serviceProvider: (providerId) =>
		delay({
			redirectUri: `${base()}/sso/callback/${providerId}`,
			acsUrl: `${base()}/sso/saml2/sp/acs/${providerId}`,
			entityId: `${base()}/sso/saml2/sp/metadata?providerId=${providerId}`,
			metadataUrl: `${base()}/sso/saml2/sp/metadata?providerId=${providerId}`,
		}),
	async createOidc(input) {
		const p: SsoProvider = {
			providerId: input.providerId,
			type: "oidc",
			issuer: input.issuer.replace(/\/+$/, ""),
			domain: input.domain,
			defaultRole: input.defaultRole,
			clientIdLastFour: input.clientId.slice(-4),
		};
		providers.push(p);
		return delay(p);
	},
	async createSaml(input) {
		const p: SsoProvider = {
			providerId: input.providerId,
			type: "saml",
			issuer: input.metadataUrl
				? new URL(input.metadataUrl).origin
				: "https://idp.example.com/saml",
			domain: input.domain,
			defaultRole: input.defaultRole,
			clientIdLastFour: null,
		};
		providers.push(p);
		return delay(p);
	},
	async remove(providerId) {
		const i = providers.findIndex((p) => p.providerId === providerId);
		if (i >= 0) providers.splice(i, 1);
		await delay(null);
	},
	// No IdP in mock mode: the popup goes straight to the callback, as after a successful sign-in.
	signInUrl: (_providerId, callbackURL) => delay(callbackURL, 400),
};
