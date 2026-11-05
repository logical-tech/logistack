// Webhook bodies trimmed from each provider's documented example payloads (unread fields removed).

export const githubPush = {
	ref: "refs/heads/main",
	before: "6113728f27ae82c7b1a177c8d03f9e96e0adf246",
	after: "0d1a26e67d8f5eaf1f6ba5c57fc3c7d91ac0fd1c",
	created: false,
	deleted: false,
	forced: false,
	repository: { id: 186853002, full_name: "Codertocat/Hello-World" },
	pusher: {
		name: "Codertocat",
		email: "21031067+Codertocat@users.noreply.github.com",
	},
	head_commit: {
		id: "0d1a26e67d8f5eaf1f6ba5c57fc3c7d91ac0fd1c",
		message: "Update README.md",
		author: {
			name: "Codertocat",
			email: "21031067+Codertocat@users.noreply.github.com",
		},
	},
	commits: [
		{
			id: "0d1a26e67d8f5eaf1f6ba5c57fc3c7d91ac0fd1c",
			message: "Update README.md",
			added: ["apps/web/new.ts"],
			removed: [],
			modified: ["README.md"],
		},
	],
};

export const githubPullRequest = {
	action: "synchronize",
	number: 2,
	pull_request: {
		number: 2,
		state: "open",
		title: "Update the README with new information.",
		user: { login: "Codertocat" },
		head: { ref: "changes", sha: "ec26c3e57ca3a959ca5aad62de7213c562f8c821" },
		base: { ref: "master", sha: "f95f852bd8fca8fcc58a9a2d6c842781e32a215e" },
	},
	repository: { id: 186853002, full_name: "Codertocat/Hello-World" },
	sender: { login: "Codertocat" },
};

export const gitlabPush = {
	object_kind: "push",
	event_name: "push",
	before: "95790bf891e76fee5e1747ab589903a6a1f80f22",
	after: "da1560886d4f094c3e6c9ef40349f7d38b5d27d7",
	ref: "refs/heads/master",
	user_name: "John Smith",
	project: { id: 15, path_with_namespace: "mike/diaspora" },
	commits: [
		{
			id: "b6568db1bc1dcd7f8b4d5a946b0b91f9dacd7327",
			message: "Update Catalan translation to e38cb41.",
			author: { name: "Jordi Mallach" },
			added: ["CHANGELOG"],
			modified: ["app/controller/application.rb"],
			removed: [],
		},
		{
			id: "da1560886d4f094c3e6c9ef40349f7d38b5d27d7",
			message: "fixed readme",
			author: { name: "GitLab dev user" },
			added: [],
			modified: ["README.md"],
			removed: ["old.txt"],
		},
	],
	total_commits_count: 2,
};

export const gitlabMergeRequest = {
	object_kind: "merge_request",
	event_type: "merge_request",
	user: { name: "Administrator", username: "root" },
	project: { id: 1, path_with_namespace: "gitlabhq/gitlab-test" },
	object_attributes: {
		iid: 1,
		action: "update",
		title: "MS-Viewport",
		source_branch: "ms-viewport",
		target_branch: "master",
		oldrev: "b83d6e391c22777fca1ed3012fce84f633d7fed0",
		last_commit: {
			id: "da1560886d4f094c3e6c9ef40349f7d38b5d27d7",
			message: "fixed readme",
		},
	},
};

export const giteaPush = {
	ref: "refs/heads/develop",
	before: "28e1879d029cb852e4844d9c718537df08844e03",
	after: "bffeb74224043ba2feb48d137756c8a9331c449a",
	repository: { id: 140, full_name: "gitea/webhooks" },
	pusher: { login: "gitea", username: "gitea" },
	head_commit: {
		id: "bffeb74224043ba2feb48d137756c8a9331c449a",
		message: "Webhooks Yay!",
		author: { name: "Gitea", username: "gitea" },
	},
	commits: [
		{
			id: "bffeb74224043ba2feb48d137756c8a9331c449a",
			message: "Webhooks Yay!",
			added: [],
			removed: [],
			modified: ["services/web/index.ts"],
		},
	],
};

export const giteaPullRequest = {
	action: "synchronized",
	number: 7,
	pull_request: {
		id: 31,
		number: 7,
		title: "Add preview support",
		user: { login: "gitea" },
		head: {
			ref: "feature/preview",
			sha: "f1d2d2f924e986ac86fdf7b36c94bcdf32beec15",
		},
		base: { ref: "main", sha: "e242ed3bffccdf271b7fbaf34ed72d089537b42f" },
	},
	repository: { id: 140, full_name: "gitea/webhooks" },
};

export const bitbucketPush = {
	actor: { display_name: "Emma" },
	repository: { full_name: "team/repo" },
	push: {
		changes: [
			{
				new: {
					type: "branch",
					name: "main",
					target: {
						type: "commit",
						hash: "709d658dc5b6d6afcd46049c2f332ee3f515a67d",
						message: "Fix the build\n",
						author: {
							raw: "Emma <emma@example.com>",
							user: { display_name: "Emma" },
						},
					},
				},
				old: { type: "branch", name: "main" },
			},
		],
	},
};

export const bitbucketPullRequest = {
	actor: { display_name: "Emma" },
	repository: { full_name: "team/repo" },
	pullrequest: {
		id: 12,
		title: "Preview environments",
		state: "OPEN",
		author: { display_name: "Emma" },
		source: { branch: { name: "feature/x" }, commit: { hash: "d3fe0e9a7c4b" } },
		destination: { branch: { name: "main" }, commit: { hash: "ce5965ddd289" } },
	},
};

export const githubTagPush = {
	ref: "refs/tags/v1.4.0",
	before: "0000000000000000000000000000000000000000",
	after: "9f2b0e1c5d7a4b3e8f6a1c2d3e4f5a6b7c8d9e0f",
	created: true,
	deleted: false,
	base_ref: "refs/heads/main",
	repository: { id: 186853002, full_name: "Codertocat/Hello-World" },
	pusher: { name: "Codertocat" },
	head_commit: {
		id: "0d1a26e67d8f5eaf1f6ba5c57fc3c7d91ac0fd1c",
		message: "chore: release 1.4.0",
		author: { name: "Codertocat" },
	},
	commits: [],
};

export const githubRelease = {
	action: "published",
	release: {
		id: 11248810,
		tag_name: "v1.4.0",
		target_commitish: "main",
		name: "1.4.0",
		draft: false,
		prerelease: false,
		author: { login: "Codertocat" },
	},
	repository: { id: 186853002, full_name: "Codertocat/Hello-World" },
	sender: { login: "Codertocat" },
};

export const gitlabTagPush = {
	object_kind: "tag_push",
	event_name: "tag_push",
	before: "0000000000000000000000000000000000000000",
	after: "82b3d5ae55f7080f1e6022629cdb57bfae7cccc7",
	ref: "refs/tags/v1.0.0",
	checkout_sha: "da1560886d4f094c3e6c9ef40349f7d38b5d27d7",
	message: "Tag message",
	user_name: "John Smith",
	project: { id: 1, path_with_namespace: "jsmith/example" },
	commits: [],
	total_commits_count: 0,
};

export const gitlabRelease = {
	object_kind: "release",
	action: "create",
	tag: "v1.1",
	name: "Awesome release",
	project: { id: 1, path_with_namespace: "jsmith/example" },
	commit: {
		id: "ee0f8b1c6f9a6d7b4ab2bfd5a9ee6a4a7a1b1e36",
		message: "Release v1.1 [skip deploy]",
		author: { name: "Example User" },
	},
};

export const giteaTagPush = {
	ref: "refs/tags/v2.0.0",
	before: "0000000000000000000000000000000000000000",
	after: "bffeb74224043ba2feb48d137756c8a9331c449a",
	repository: { id: 140, full_name: "gitea/webhooks" },
	pusher: { login: "gitea", username: "gitea" },
	head_commit: {
		id: "bffeb74224043ba2feb48d137756c8a9331c449a",
		message: "Webhooks Yay!",
		author: { name: "Gitea", username: "gitea" },
	},
	commits: [],
};

export const giteaRelease = {
	action: "published",
	release: {
		id: 3,
		tag_name: "v2.0.0-rc.1",
		target_commitish: "main",
		name: "",
		author: { login: "gitea" },
	},
	repository: { id: 140, full_name: "gitea/webhooks" },
	sender: { login: "gitea" },
};

export const bitbucketTagPush = {
	actor: { display_name: "Emma" },
	repository: { full_name: "team/repo" },
	push: {
		changes: [
			{
				new: {
					type: "tag",
					name: "v3.1.0",
					target: {
						type: "commit",
						hash: "709d658dc5b6d6afcd46049c2f332ee3f515a67d",
						message: "Bump to 3.1.0 [ci skip]\n",
						author: { raw: "Emma <emma@example.com>" },
					},
				},
				old: null,
			},
		],
	},
};
