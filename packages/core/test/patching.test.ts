import { describe, expect, test } from "bun:test";
import {
	compareKernels,
	currentPatchNode,
	newerKernelInstalled,
	nextPatchStep,
	packageManagerFor,
	parseAptSimulate,
	parseBootId,
	parseDnfCheckUpdate,
	parseDnfSecurity,
	parseOsRelease,
	upgradeCommands,
} from "../src/patching.ts";

const APT = `Calculating upgrade...
47 upgraded, 1 newly installed, 0 to remove and 0 not upgraded.
Inst bash [5.2.15-2+b2] (5.2.15-2+b13 Debian:12.15/oldstable [arm64])
Inst libgcrypt20 [1.10.1-3] (1.10.1-3+deb12u1 Debian:12.15/oldstable, Debian-Security:12/oldstable-security [arm64])
Inst gcc-12-base [12.2.0-14] (12.2.0-14+deb12u1 Debian:12.15/oldstable [arm64]) [libstdc++6:arm64 ]
Inst linux-image-6.8.0-51-generic (6.8.0-51.52 Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security [amd64])
Conf bash (5.2.15-2+b13 Debian:12.15/oldstable [arm64])`;

describe("apt", () => {
	test("parses the simulated upgrade, flags security origins and new packages", () => {
		expect(parseAptSimulate(APT)).toEqual([
			{
				name: "bash",
				from: "5.2.15-2+b2",
				to: "5.2.15-2+b13",
				security: false,
			},
			{
				name: "libgcrypt20",
				from: "1.10.1-3",
				to: "1.10.1-3+deb12u1",
				security: true,
			},
			{
				name: "gcc-12-base",
				from: "12.2.0-14",
				to: "12.2.0-14+deb12u1",
				security: false,
			},
			{
				name: "linux-image-6.8.0-51-generic",
				from: null,
				to: "6.8.0-51.52",
				security: true,
			},
		]);
	});

	test("security-only upgrades the security packages by name, after repairing dpkg", () => {
		const cmds = upgradeCommands("apt", {
			securityOnly: true,
			updates: [
				...parseAptSimulate(APT),
				{ name: "-oAPT::evil=1", from: null, to: "1", security: true },
			],
		});
		expect(cmds[0]).toEqual(["dpkg", "--configure", "-a"]);
		expect(cmds[1]?.slice(-3)).toEqual([
			"--only-upgrade",
			"libgcrypt20",
			"linux-image-6.8.0-51-generic",
		]);
	});

	test("nothing to do when no security update is pending", () => {
		expect(upgradeCommands("apt", { securityOnly: true, updates: [] })).toEqual(
			[["dpkg", "--configure", "-a"]],
		);
	});
});

describe("dnf", () => {
	test("parses check-update and matches advisories by name", () => {
		const sec = parseDnfSecurity(
			`RHSA-2024:1234 Important/Sec. openssl-libs-1:3.0.7-25.el9.x86_64
RHSA-2024:2222 Moderate/Sec.  kernel-5.14.0-362.24.1.el9_3.x86_64`,
		);
		expect([...sec]).toEqual(["openssl-libs", "kernel"]);
		const out = `
Last metadata expiration check: 0:01:02 ago.

kernel.x86_64          5.14.0-362.24.1.el9_3   baseos
openssl-libs.x86_64    1:3.0.7-25.el9          baseos
vim-minimal.x86_64     2:8.2.2637-20.el9_1     baseos
Obsoleting Packages
grub2-tools.x86_64     1:2.06-70.el9           baseos`;
		expect(parseDnfCheckUpdate(out, sec)).toEqual([
			{
				name: "kernel",
				from: null,
				to: "5.14.0-362.24.1.el9_3",
				security: true,
			},
			{
				name: "openssl-libs",
				from: null,
				to: "1:3.0.7-25.el9",
				security: true,
			},
			{
				name: "vim-minimal",
				from: null,
				to: "2:8.2.2637-20.el9_1",
				security: false,
			},
		]);
	});
});

test("os-release picks the package manager, ID_LIKE included", () => {
	const os = parseOsRelease(
		'ID=rocky\nID_LIKE="rhel centos fedora"\nPRETTY_NAME="Rocky Linux 9.3"',
	);
	expect(os.pretty).toBe("Rocky Linux 9.3");
	expect(packageManagerFor(os)).toBe("dnf");
	expect(packageManagerFor({ id: "linuxmint", like: [] })).toBe("apt");
	expect(packageManagerFor({ id: "kali", like: ["debian"] })).toBe("apt");
	expect(packageManagerFor({ id: "alpine", like: [] })).toBeNull();
});

test("kernels compare by their numbers", () => {
	expect(
		compareKernels("6.8.0-51-generic", "6.8.0-49-generic"),
	).toBeGreaterThan(0);
	expect(
		compareKernels("6.11.0-9-generic", "6.8.0-51-generic"),
	).toBeGreaterThan(0);
	expect(compareKernels("6.8.0-49-generic", "6.8.0-49-generic")).toBe(0);
	expect(
		newerKernelInstalled(
			"6.8.0-49-generic",
			"config-6.8.0-49-generic\nvmlinuz-6.8.0-49-generic\nvmlinuz-6.8.0-51-generic\nvmlinuz",
		),
	).toBe(true);
	expect(
		newerKernelInstalled(
			"6.8.0-51-generic",
			"vmlinuz-6.8.0-49-generic\nvmlinuz-6.8.0-51-generic",
		),
	).toBe(false);
});

test("boot identity reads the boot id and PID 1's start time", () => {
	const stat =
		"1 (systemd (x)) S 0 1 1 0 -1 4194560 1 2 3 4 5 6 7 8 20 0 1 0 4242 1000";
	expect(parseBootId(`93c855a3\n${stat}\n`)).toBe("93c855a3:4242");
});

test("steps skip the reboot when none is due or reboots are off", () => {
	const walk = (o: Parameters<typeof nextPatchStep>[1]) => {
		const steps = ["scan"];
		for (let s = nextPatchStep("scan", o); s; s = nextPatchStep(s, o))
			steps.push(s);
		return steps;
	};
	expect(walk({ reboot: "if_needed", rebootRequired: true })).toEqual([
		"scan",
		"drain",
		"upgrade",
		"reboot",
		"rejoin",
		"healthy",
		"undrain",
	]);
	expect(walk({ reboot: "if_needed", rebootRequired: false })).toEqual([
		"scan",
		"drain",
		"upgrade",
		"healthy",
		"undrain",
	]);
	expect(walk({ reboot: "never", rebootRequired: true })).not.toContain(
		"reboot",
	);
});

test("a run works on the running node, else the first pending one", () => {
	expect(
		currentPatchNode([
			{ state: "succeeded" },
			{ state: "pending" },
			{ state: "running" },
		]),
	).toEqual({ state: "running" });
	expect(currentPatchNode([{ state: "failed" }, { state: "pending" }])).toEqual(
		{ state: "pending" },
	);
	expect(currentPatchNode([{ state: "succeeded" }])).toBeUndefined();
});
