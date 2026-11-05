import { z } from "zod";
import { defineProvider, ProviderError } from "../http.ts";
import { type GitProvider, WebhookRejectedError } from "./types.ts";

/** `ssh://[user@]host[:port]/path` or scp-style `user@host:path`. */
const SSH_URL =
	/^(ssh:\/\/([\w.-]+@)?[\w.-]+(:\d+)?\/\S+|[\w.-]+@[\w.-]+:[^\s/]\S*)$/;

/** Any git server over SSH with a deploy key; LogiStack has no API to call, so nothing is listed. */
export const genericConfig = z.object({
	repoUrl: z.string().regex(SSH_URL, "expected an SSH git URL"),
	/** The `ssh_key` row whose private key the clone uses. */
	sshKeyId: z.string().min(1),
	/** `known_hosts` lines pinning the server's host key; without them the first key seen is trusted. */
	knownHosts: z.string().optional(),
});
export type GenericGitConfig = z.infer<typeof genericConfig>;

export const generic = defineProvider({
	configSchema: genericConfig,
	create(config): GitProvider {
		return {
			async listRepos() {
				return [{ fullName: config.repoUrl, private: true }];
			},
			async listBranches() {
				throw new ProviderError(
					"generic",
					"listBranches",
					"not available without a provider API; enter the branch by hand",
				);
			},
			async getCloneUrl() {
				return config.repoUrl;
			},
			async commitChecks() {
				throw new ProviderError(
					"generic",
					"commitChecks",
					"not available without a provider API",
				);
			},
			async verifyWebhook() {
				throw new WebhookRejectedError("generic", "not_configured");
			},
		};
	},
});
