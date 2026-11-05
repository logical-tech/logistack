import type { BasicAuthUserInput } from "@logistack/contracts";
import { Failure } from "./errors.ts";

export type HashedUser = { username: string; hash: string };

/** Bcrypt-hashes new passwords; a user listed without one keeps the hash in `kept`. */
export function hashUsers(
	users: BasicAuthUserInput[],
	kept: HashedUser[],
): Promise<HashedUser[]> {
	if (new Set(users.map((u) => u.username)).size !== users.length)
		throw new Failure("bad_request", "usernames must be unique");
	return Promise.all(
		users.map(async (u) => {
			if (u.password)
				return {
					username: u.username,
					hash: await Bun.password.hash(u.password, {
						algorithm: "bcrypt",
						cost: 10,
					}),
				};
			const old = kept.find((x) => x.username === u.username);
			if (!old)
				throw new Failure("bad_request", `${u.username} needs a password`);
			return old;
		}),
	);
}
