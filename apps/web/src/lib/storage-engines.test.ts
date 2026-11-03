import { expect, test } from "bun:test";
import { storageEngineDefs } from "@logistack/core";
import { STORAGE_ENGINES } from "./storage-engines";

test("the wizard's engine table matches the engines the server deploys", () => {
	expect(Object.keys(STORAGE_ENGINES)).toEqual(Object.keys(storageEngineDefs));
	for (const [engine, def] of Object.entries(storageEngineDefs)) {
		const info = STORAGE_ENGINES[engine as keyof typeof STORAGE_ENGINES];
		expect({
			label: info.label,
			version: info.version,
			s3Port: info.s3Port,
			consolePort: info.consolePort,
			versioning: info.versioning,
			bucketPolicy: info.bucketPolicy,
			usage: info.usage,
			console: info.consolePort !== null,
		}).toEqual({
			label: def.label,
			version: def.version,
			s3Port: def.s3Port,
			consolePort: def.consolePort ?? null,
			versioning: def.capabilities.versioning,
			bucketPolicy: def.capabilities.bucketPolicy,
			usage: def.capabilities.usage,
			console: def.capabilities.console,
		});
	}
});
