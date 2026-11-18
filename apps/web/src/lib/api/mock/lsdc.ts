import {
	type LsdcInstance,
	LsdcInstanceUpdate,
	LsdcProvisionInput,
	type LsdcUsage,
} from "@logistack/contracts";
import { ApiError } from "../adapter";
import type { LsdcApi } from "../lsdc";

/*
 * Three customers on managed back offices: two healthy, one whose domain stopped answering.
 * Usage arrives slowly on purpose, as it does from a real instance.
 */

const delay = <T>(v: T, ms = 160 + Math.random() * 200) =>
	new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));

const ago = (days: number) =>
	new Date(Date.now() - days * 86_400_000).toISOString();

const slug = (customer: string) =>
	`lsdc-${
		customer
			.normalize("NFKD")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 50) || "instance"
	}`;

let instances: LsdcInstance[] = [
	{
		id: "stk_lsdc_ferretti",
		serviceId: "svc_lsdc_ferretti",
		name: "lsdc-ferretti-logistica",
		projectId: "prj_backoffice",
		projectName: "Back office",
		environmentId: "env_backoffice_production",
		environmentName: "Production",
		hostname: "gestionale.ferrettilogistica.it",
		desiredState: "running",
		customer: "Ferretti Logistica S.r.l.",
		priceCents: 14_900,
		currency: "EUR",
		limits: { cpu: 2, ramMb: 2048, storageMb: 51_200 },
		managed: true,
		createdAt: ago(212),
	},
	{
		id: "stk_lsdc_rossi",
		serviceId: "svc_lsdc_rossi",
		name: "lsdc-studio-rossi",
		projectId: "prj_rossi",
		projectName: "Studio Rossi",
		environmentId: "env_rossi_production",
		environmentName: "Production",
		hostname: "lsdc-studio-rossi.203-0-113-7.sslip.io",
		desiredState: "running",
		customer: "Studio Rossi",
		priceCents: 4_900,
		currency: "EUR",
		limits: { cpu: 0.5, ramMb: 512, storageMb: 2048 },
		managed: true,
		createdAt: ago(61),
	},
	{
		id: "stk_lsdc_nordwind",
		serviceId: "svc_lsdc_nordwind",
		name: "lsdc-nordwind-reisen",
		projectId: "prj_booking",
		projectName: "Booking API",
		environmentId: "env_booking_production",
		environmentName: "Production",
		hostname: "office.nordwind-reisen.de",
		desiredState: "running",
		customer: "Nordwind Reisen GmbH",
		priceCents: 8_900,
		currency: "CHF",
		limits: { cpu: 1, ramMb: 1024, storageMb: 10_240 },
		managed: true,
		createdAt: ago(18),
	},
];

const USAGE: Record<string, LsdcUsage> = {
	stk_lsdc_ferretti: {
		reachable: true,
		cpu: 0.62,
		ramMb: 1530,
		storageMb: 31_874,
	},
	stk_lsdc_rossi: { reachable: true, cpu: 0.04, ramMb: 238, storageMb: 1880 },
	stk_lsdc_nordwind: {
		reachable: false,
		reason: "connect ETIMEDOUT office.nordwind-reisen.de:443",
	},
};

const find = (id: string) => {
	const inst = instances.find((x) => x.id === id);
	if (!inst) throw new ApiError(404, "instance not found", "not_found");
	return inst;
};

export const mockLsdc: LsdcApi = {
	list: () => delay(instances),
	usage: async (id) => {
		find(id);
		return delay(
			USAGE[id] ?? {
				reachable: true,
				cpu: 0.01,
				ramMb: 142,
				storageMb: 12,
			},
			700 + Math.random() * 1500,
		);
	},
	provision: async (environmentId, raw) => {
		const input = LsdcProvisionInput.parse(raw);
		const name = slug(input.customer);
		if (
			instances.some(
				(x) => x.environmentId === environmentId && x.name === name,
			)
		)
			throw new ApiError(
				409,
				`a stack named ${name} already exists in this environment`,
				"conflict",
			);
		const id = `stk_${name.slice(5, 20)}_${Date.now().toString(36)}`;
		// Fixture environment ids are env_<project slug>_<kind>.
		const [, project = "", kind = "production"] = environmentId.split("_");
		const instance: LsdcInstance = {
			id,
			serviceId: id.replace(/^stk_/, "svc_"),
			name,
			projectId: `prj_${project}`,
			projectName: project,
			environmentId,
			environmentName: kind.charAt(0).toUpperCase() + kind.slice(1),
			hostname: input.domain || `${name}.203-0-113-7.sslip.io`,
			desiredState: "running",
			customer: input.customer,
			priceCents: input.priceCents,
			currency: input.currency,
			limits: input.limits,
			managed: true,
			createdAt: new Date().toISOString(),
		};
		instances = [...instances, instance];
		return delay(
			{
				instance,
				adminPassword: input.adminEmail ? "tR7m-Qx2k-Lp9v-Wb4n" : null,
			},
			900,
		);
	},
	update: async (id, raw) => {
		const input = LsdcInstanceUpdate.parse(raw);
		const inst = find(id);
		const next: LsdcInstance = {
			...inst,
			...(input.customer !== undefined && { customer: input.customer }),
			...(input.priceCents !== undefined && { priceCents: input.priceCents }),
			...(input.currency && { currency: input.currency }),
			...(input.limits && { limits: input.limits, managed: true }),
		};
		instances = instances.map((x) => (x.id === id ? next : x));
		return delay(next);
	},
};
