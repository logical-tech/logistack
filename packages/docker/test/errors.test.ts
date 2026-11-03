import { expect, test } from "bun:test";
import { toDockerError } from "../src/errors.ts";

test("a concurrent swarm create of the same name is a conflict, like a 409", () => {
	const raced = toDockerError(
		500,
		'{"message":"rpc error: code = Unknown desc = name conflicts with an existing object"}',
		"POST",
		"/networks/create",
	);
	expect(raced.conflict).toBe(true);
	expect(
		toDockerError(409, '{"message":"exists"}', "POST", "/x").conflict,
	).toBe(true);
	expect(toDockerError(500, '{"message":"boom"}', "POST", "/x").conflict).toBe(
		false,
	);
});
