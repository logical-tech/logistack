import { ApiError } from "../adapter";
import type { InstanceAdmin, InstanceAdminsApi } from "../instance-admins";

let admins: InstanceAdmin[] = [
	{ id: "usr_simone", name: "Simone Maddiona", email: "simone@logicaltech.it" },
];

const delay = <T>(v: T) =>
	new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), 250));

export const mockInstanceAdmins: InstanceAdminsApi = {
	list: () => delay(admins),
	add: async (email) => {
		const known = email.toLowerCase().endsWith("@logicaltech.it");
		if (!known) throw new ApiError(404, "user not found", "not_found");
		if (!admins.some((a) => a.email === email.toLowerCase()))
			admins = [
				...admins,
				{
					id: `usr_${email.split("@")[0]}`,
					name: email.split("@")[0] ?? email,
					email,
				},
			];
		return delay(admins);
	},
	remove: async (id) => {
		if (admins.length === 1)
			throw new ApiError(
				409,
				"the instance needs at least one admin; add another first",
				"conflict",
			);
		admins = admins.filter((a) => a.id !== id);
		return delay(admins);
	},
};
