import { z } from "zod";
import { isDnsName } from "./dns.ts";

/*
 * People and devices of the home network. A person is a virtual member: a name to group devices
 * under, with no sign-in. A device is a client of the home DNS, known by its IP address. Both can
 * block more than the whole house does; the worker turns that into Technitium's Advanced Blocking
 * groups, picked by client address. The house's own lists still apply to everyone.
 */

const Domain = z
	.string()
	.trim()
	.toLowerCase()
	.transform((n) => n.replace(/^\*\./, "").replace(/\.$/, ""))
	.refine((n) => isDnsName(n) && !n.startsWith("*"), "enter a domain name");

/** Blocked on top of the house's lists: list URLs (hosts files or domain lists) and single domains. */
export const NetworkBlocking = z.object({
	listUrls: z
		.array(
			z
				.string()
				.trim()
				.pipe(z.url({ protocol: /^https?$/ })),
		)
		.max(50)
		.default([]),
	/** A domain blocks its subdomains too. */
	blocked: z.array(Domain).max(2000).default([]),
});
export type NetworkBlocking = z.infer<typeof NetworkBlocking>;

const Name = z.string().trim().min(1).max(80);

export const NetworkPerson = z.object({
	id: z.string(),
	name: Name,
	blocking: NetworkBlocking,
	devices: z.number(),
	createdAt: z.string(),
});
export type NetworkPerson = z.infer<typeof NetworkPerson>;

export const NetworkPersonInput = z.object({
	name: Name,
	blocking: NetworkBlocking.default({ listUrls: [], blocked: [] }),
});
export type NetworkPersonInput = z.infer<typeof NetworkPersonInput>;

// Built from fields without defaults: zod applies `.default()` inside `.partial()` too, so a PATCH would reset what it omits.
export const NetworkPersonUpdateInput = z
	.object({ name: Name, blocking: NetworkBlocking })
	.partial()
	.refine((o) => Object.keys(o).length > 0, "nothing to update");

/** The address the device asks the home DNS from; give it a fixed IP or a DHCP reservation. */
export const NetworkDeviceAddress = z.union([z.ipv4(), z.ipv6()]);

export const NetworkDevice = z.object({
	id: z.string(),
	name: Name,
	address: z.string(),
	personId: z.string().nullable(),
	personName: z.string().nullable(),
	blocking: NetworkBlocking,
	createdAt: z.string(),
});
export type NetworkDevice = z.infer<typeof NetworkDevice>;

export const NetworkDeviceInput = z.object({
	name: Name,
	address: NetworkDeviceAddress,
	personId: z.string().min(1).nullable().default(null),
	blocking: NetworkBlocking.default({ listUrls: [], blocked: [] }),
});
export type NetworkDeviceInput = z.infer<typeof NetworkDeviceInput>;

export const NetworkDeviceUpdateInput = z
	.object({
		name: Name,
		address: NetworkDeviceAddress,
		personId: z.string().min(1).nullable(),
		blocking: NetworkBlocking,
	})
	.partial()
	.refine((o) => Object.keys(o).length > 0, "nothing to update");
export type NetworkDeviceUpdateInput = z.infer<typeof NetworkDeviceUpdateInput>;
