import type { BuildPlatforms } from "@logistack/contracts";
import type { BuildsApi } from "../builds";

const delay = <T>(value: T, ms = 200 + Math.random() * 300): Promise<T> =>
	new Promise((resolve) =>
		setTimeout(() => resolve(structuredClone(value)), ms),
	);

/** A mixed swarm whose BuildKit runs on amd64 without emulation: the case the setup exists for. */
const state: BuildPlatforms = {
	swarm: ["linux/amd64", "linux/arm64"],
	buildkit: {
		platforms: ["linux/amd64", "linux/amd64/v2", "linux/386"],
		checkedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
		error: null,
		emulation: null,
	},
	missing: ["linux/arm64"],
};

/** `localStorage["ls-mock-binfmt-fail"] = "1"` makes the setup fail the way a kernel without binfmt_misc does. */
const failing = () => {
	try {
		return localStorage.getItem("ls-mock-binfmt-fail") === "1";
	} catch {
		return false;
	}
};

export const mockBuilds: BuildsApi = {
	platforms: () => delay(state),
	check: () => {
		setTimeout(() => {
			state.buildkit.checkedAt = new Date().toISOString();
		}, 1_200);
		return delay(state);
	},
	setUpEmulation: () => {
		state.buildkit.emulation = {
			state: "installing",
			error: null,
			at: new Date().toISOString(),
		};
		setTimeout(() => {
			const at = new Date().toISOString();
			if (failing()) {
				state.buildkit.emulation = {
					state: "failed",
					error:
						"BuildKit still cannot build linux/arm64; the node's kernel may lack binfmt_misc",
					at,
				};
				return;
			}
			state.buildkit.platforms = [
				"linux/amd64",
				"linux/amd64/v2",
				"linux/arm64",
				"linux/386",
			];
			state.buildkit.checkedAt = at;
			state.buildkit.emulation = { state: "installed", error: null, at };
			state.missing = [];
		}, 5_000);
		return delay(state);
	},
};
