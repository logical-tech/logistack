-- Plugin index (docs/plans/plugins.md, "Marketplace and distribution"). Times are unix seconds.
-- Migrations only add (CLAUDE.md rule 10).

CREATE TABLE publishers (
	id TEXT PRIMARY KEY,
	email TEXT NOT NULL UNIQUE,
	-- Shown on the index; the email never is.
	name TEXT NOT NULL DEFAULT '',
	suspended_at INTEGER,
	suspended_reason TEXT,
	created_at INTEGER NOT NULL
);

-- A publisher whose email is here may use the admin queue and the reserved id prefixes.
CREATE TABLE admins (
	email TEXT PRIMARY KEY,
	created_at INTEGER NOT NULL
);

-- Magic-link sign-in: sha256 of the emailed token, single use.
CREATE TABLE login_tokens (
	hash TEXT PRIMARY KEY,
	email TEXT NOT NULL,
	expires_at INTEGER NOT NULL
);
CREATE INDEX login_tokens_email ON login_tokens (email);

CREATE TABLE sessions (
	hash TEXT PRIMARY KEY,
	publisher_id TEXT NOT NULL REFERENCES publishers (id),
	expires_at INTEGER NOT NULL
);

-- Bearer tokens for `logistack-plugin publish` and CI, created from the dashboard.
CREATE TABLE api_tokens (
	hash TEXT PRIMARY KEY,
	publisher_id TEXT NOT NULL REFERENCES publishers (id),
	name TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	last_used_at INTEGER
);

CREATE TABLE plugins (
	-- Reverse-DNS, first come first served.
	id TEXT PRIMARY KEY,
	publisher_id TEXT NOT NULL REFERENCES publishers (id),
	created_at INTEGER NOT NULL
);

CREATE TABLE versions (
	id TEXT PRIMARY KEY,
	plugin_id TEXT NOT NULL REFERENCES plugins (id),
	version TEXT NOT NULL,
	-- registry/repository@sha256:…
	image TEXT NOT NULL,
	manifest TEXT NOT NULL,
	readme TEXT NOT NULL DEFAULT '',
	changelog TEXT NOT NULL DEFAULT '',
	icon_url TEXT,
	status TEXT NOT NULL CHECK (status IN ('pending', 'unverified', 'verified', 'rejected', 'yanked')),
	review_notes TEXT NOT NULL DEFAULT '',
	-- Set when an admin marks the version verified: who, and the source commit reviewed.
	reviewer TEXT,
	reviewed_commit TEXT,
	-- JSON from the CI review job (contract test, vulnerability scan).
	checks TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	UNIQUE (plugin_id, version)
);
CREATE INDEX versions_status ON versions (status);

CREATE TABLE reports (
	id TEXT PRIMARY KEY,
	plugin_id TEXT NOT NULL,
	version TEXT,
	reason TEXT NOT NULL,
	contact TEXT,
	status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
	resolution TEXT,
	created_at INTEGER NOT NULL,
	resolved_at INTEGER
);

-- Opt-in anonymous pings: a random per-install id, no IP or instance data. Counted per plugin.
CREATE TABLE install_pings (
	plugin_id TEXT NOT NULL,
	install_id TEXT NOT NULL,
	last_seen INTEGER NOT NULL,
	PRIMARY KEY (plugin_id, install_id)
);
