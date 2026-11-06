import { describe, expect, test } from "bun:test";
import {
	type ResourceProfiles,
	ResourceProfiles as ResourceProfilesSchema,
	type ServiceSpec,
} from "@logistack/contracts";
import {
	applyResourceProfile,
	seededResourceProfiles,
} from "../src/resource-profiles.ts";

const settings: ResourceProfiles = {
	profiles: [
		{ name: "Small", cpu: 0.5, memoryMb: 512 },
		{ name: "Memory only", memoryMb: 2048 },
	],
	defaultProfile: "Small",
};

const db = (resources: { cpu?: number; memoryMb?: number }): ServiceSpec => ({
	kind: "database",
	engine: "postgres",
	version: "17",
	credentialsRef: "env",
	resources,
});

describe("applyResourceProfile", () => {
	test("a spec without limits gets the organization default", () => {
		expect(applyResourceProfile(db({}), undefined, settings)).toEqual(
			db({ cpu: 0.5, memoryMb: 512 }),
		);
	});

	test("limits the caller set win over the default", () => {
		expect(applyResourceProfile(db({ cpu: 3 }), undefined, settings)).toEqual(
			db({ cpu: 3 }),
		);
	});

	test("no default leaves the spec unlimited", () => {
		expect(
			applyResourceProfile(db({}), undefined, {
				...settings,
				defaultProfile: null,
			}),
		).toEqual(db({}));
	});

	test("a named profile replaces whatever the spec carried, absent limits included", () => {
		expect(
			applyResourceProfile(
				db({ cpu: 3, memoryMb: 64 }),
				"Memory only",
				settings,
			),
		).toEqual(db({ memoryMb: 2048 }));
	});

	test("null opts out of the default", () => {
		expect(applyResourceProfile(db({}), null, settings)).toEqual(db({}));
	});

	test("an unknown profile is refused", () => {
		expect(() => applyResourceProfile(db({}), "Huge", settings)).toThrow(
			"no resource profile named Huge",
		);
	});

	test("compose specs are left alone", () => {
		const compose: ServiceSpec = {
			kind: "compose",
			source: { type: "inline" },
			originalYaml: "services: {}",
			servicesOverrides: {},
		};
		expect(applyResourceProfile(compose, undefined, settings)).toBe(compose);
	});
});

describe("ResourceProfiles", () => {
	test("the seeded list is valid", () => {
		expect(ResourceProfilesSchema.parse(seededResourceProfiles)).toEqual(
			seededResourceProfiles,
		);
	});

	test("refuses duplicate names and a default that is not in the list", () => {
		const dup = {
			...settings,
			profiles: [...settings.profiles, { name: "Small" }],
		};
		expect(ResourceProfilesSchema.safeParse(dup).success).toBe(false);
		expect(
			ResourceProfilesSchema.safeParse({ ...settings, defaultProfile: "Huge" })
				.success,
		).toBe(false);
	});
});
