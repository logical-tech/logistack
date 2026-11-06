import {
	type LiveMessage,
	type UpdateStep,
	type UpdateStepState,
	updateChannel,
} from "@logistack/contracts";
import { ApiError } from "../adapter";
import type { UpdateRun, UpdateStatus, UpdatesApi } from "../updates";

function delay<T>(value: T, ms = 200 + Math.random() * 300): Promise<T> {
	return new Promise((resolve) =>
		setTimeout(() => resolve(structuredClone(value)), ms),
	);
}

const DAY = 86_400_000;
const NOTES = `## Features

- **web:** Settings > Updates shows the running release, the latest one and its notes (4f1c2a9)
- **worker:** in-app updates through a one-shot updater job that outlives the worker (9fd63e0)
- **server:** daily release check with \`instance.update_available\` notifications (414a735)
- **install:** \`install.sh --version latest\`, and upgrades from \`--local-build\` installs (c55df62)

## Fixes

- **worker:** node sync leaves the installer's labels to Swarm (429a572)
- **install:** --enable-ingress keeps the tunnel until Caddy answers (ca0fbbd)

## Upgrade

In the dashboard, open **Settings > Updates** and choose **Update to v0.2.0**. From the server:

\`\`\`sh
curl -fsSL https://github.com/logical-tech/logistack/releases/download/v0.2.0/install.sh | sudo bash -s -- --version 0.2.0
\`\`\`

**Full changelog:** https://github.com/logical-tech/logistack/compare/v0.1.0...v0.2.0`;

const state: UpdateStatus = {
	current: { version: "0.1.0", commit: "5ed55b5" },
	latest: {
		version: "0.2.0",
		name: "v0.2.0",
		notes: NOTES,
		url: "https://github.com/logical-tech/logistack/releases/tag/v0.2.0",
		publishedAt: new Date(Date.now() - 2 * DAY).toISOString(),
	},
	latestError: null,
	checkedAt: new Date().toISOString(),
	updateAvailable: true,
	autoCheck: true,
	beta: false,
	run: null,
};

const listeners = new Map<string, Set<(m: LiveMessage) => void>>();
const emit = (run: UpdateRun, line?: string) => {
	if (line) run.log.push(line);
	run.updatedAt = new Date().toISOString();
	const m: LiveMessage = {
		kind: "update",
		channel: updateChannel(run.id),
		state: run.state,
		steps: { ...run.steps },
		line,
	};
	for (const fn of listeners.get(m.channel) ?? []) fn(structuredClone(m));
};

const SERVICES: [UpdateStep, string][] = [
	["logistack-api", "logistack_logistack-api"],
	["logistack-agent", "logistack_logistack-agent"],
	["caddy", "logistack_caddy"],
	["logistack-worker", "logistack_logistack-worker"],
];

/** Plays the run the updater would: pull, drain, migrate, then each service. `ls-mock-update-fail=1` fails Caddy. */
async function play(run: UpdateRun) {
	const tick = (ms = 1_100) => new Promise((r) => setTimeout(r, ms));
	const set = (step: UpdateStep, s: UpdateStepState, line?: string) => {
		run.steps[step] = s;
		emit(run, line);
	};
	const fail = localStorage.getItem("ls-mock-update-fail") === "1";
	await tick(600);
	run.state = "running";
	set("pull", "running", "Pulling ghcr.io/logical-tech/logistack:0.2.0");
	for (const name of [
		"logistack-worker",
		"logistack-agent",
		"logistack-caddy",
	]) {
		await tick(500);
		emit(run, `Pulling ghcr.io/logical-tech/${name}:0.2.0`);
	}
	set("pull", "done");
	set(
		"drain",
		"running",
		"Paused new deployments, backups and migration steps",
	);
	await tick(400);
	emit(run, "Waiting for 2 deployments and 1 backup");
	await tick(1_600);
	emit(run, "Waiting for 1 deployment");
	await tick(1_600);
	set("drain", "done", "Nothing is running");
	await tick(300);
	set(
		"migrate",
		"running",
		"Migrating the database with ghcr.io/logical-tech/logistack:0.2.0",
	);
	await tick(1_400);
	set("migrate", "done", "Database migrated");
	const done: UpdateStep[] = [];
	for (const [step, service] of SERVICES) {
		await tick(300);
		set(step, "running", `Updating ${service} to ghcr.io/logical-tech/…:0.2.0`);
		await tick(step === "logistack-api" ? 2_400 : 1_600);
		if (fail && step === "caddy") {
			set(step, "failed", `${service} failed: task exited with code 1`);
			for (const back of done.toReversed()) {
				await tick(900);
				set(back, "rolled_back", `Rolling ${back} back to 0.1.0`);
			}
			run.state = "failed";
			run.error =
				"caddy did not become healthy (task exited with code 1). Rolled back logistack-agent, logistack-api.";
			emit(run, "Deployments, backups and migrations resumed");
			emit(run, run.error);
			return;
		}
		set(step, "done", `${service} is healthy`);
		done.push(step);
	}
	emit(run, "Deployments, backups and migrations resumed");
	run.state = "succeeded";
	state.current = { version: run.toVersion, commit: "4f1c2a9" };
	state.updateAvailable = false;
	emit(run, `Updated to ${run.toVersion}`);
}

export const mockUpdates: UpdatesApi = {
	status: (refresh) => {
		if (refresh) state.checkedAt = new Date().toISOString();
		return delay(state, refresh ? 700 : undefined);
	},
	start: (version) => {
		if (state.run?.state === "queued" || state.run?.state === "running")
			return Promise.reject(
				new ApiError(409, "an update is already running", "conflict"),
			);
		const now = new Date().toISOString();
		const run: UpdateRun = {
			id: `upd_${Math.random().toString(36).slice(2, 10)}`,
			fromVersion: state.current.version,
			toVersion: version,
			state: "queued",
			steps: {
				pull: "pending",
				drain: "pending",
				migrate: "pending",
				"logistack-api": "pending",
				"logistack-agent": "pending",
				caddy: "pending",
				"logistack-worker": "pending",
			},
			log: ["Starting the updater ls-update-mock"],
			error: null,
			createdAt: now,
			updatedAt: now,
		};
		state.run = run;
		void play(run);
		return delay(run, 300);
	},
	setAutoCheck: (enabled) => {
		state.autoCheck = enabled;
		return delay({ enabled });
	},
	setBeta: (enabled) => {
		state.beta = enabled;
		return delay({ enabled });
	},
	live: (channel, fn) => {
		const set = listeners.get(channel) ?? new Set();
		listeners.set(channel, set);
		set.add(fn);
		return () => set.delete(fn);
	},
};
