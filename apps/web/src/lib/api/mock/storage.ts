import type { StorageEngine } from "@logistack/contracts";
import { STORAGE_ENGINES } from "@/lib/storage-engines";
import { ApiError } from "../adapter";
import type {
	AccessKey,
	Bucket,
	ObjectPage,
	StorageApi,
	StorageListItem,
} from "../storage";
import { mockDb as db } from ".";

const delay = <T>(value: T, ms = 160 + Math.random() * 260): Promise<T> =>
	new Promise((resolve) =>
		setTimeout(() => resolve(structuredClone(value)), ms),
	);
const rid = (prefix: string) =>
	`${prefix}_${Math.random().toString(36).slice(2, 10)}`;
const MIN = 60_000;
const at = (minutesAgo: number) =>
	new Date(Date.now() - minutesAgo * MIN).toISOString();
const KB = 1024;
const MB = 1024 ** 2;
const GB = 1024 ** 3;
const PAGE = 100;

type MockObject = {
	key: string;
	size: number;
	lastModified: string;
	etag: string;
	contentType: string;
	/** Uploaded in this session: previews and downloads return the real bytes. */
	file?: Blob;
};
type MockBucket = {
	name: string;
	createdAt: string;
	versioning: boolean;
	access: "private" | "public-read";
	objects: Map<string, MockObject>;
};
type Store = {
	engine: StorageEngine;
	buckets: MockBucket[];
	keys: AccessKey[];
	accessKeyId: string;
	/** Shows the locked root-credentials state, as for a member without read:secrets. */
	secretsForbidden?: boolean;
};

const TYPES: Record<string, string> = {
	jpg: "image/jpeg",
	png: "image/png",
	webp: "image/webp",
	svg: "image/svg+xml",
	json: "application/json",
	jsonl: "application/x-ndjson",
	csv: "text/csv",
	txt: "text/plain",
	log: "text/plain",
	md: "text/markdown",
	pdf: "application/pdf",
	mp4: "video/mp4",
	gz: "application/gzip",
	parquet: "application/vnd.apache.parquet",
	woff2: "font/woff2",
	css: "text/css",
};
const typeOf = (key: string) =>
	TYPES[key.split(".").pop()?.toLowerCase() ?? ""] ??
	"application/octet-stream";

let etagSeed = 7;
const etag = () => {
	etagSeed = (Math.imul(etagSeed, 1664525) + 1013904223) >>> 0;
	return `"${etagSeed.toString(16).padStart(8, "0")}${(etagSeed ^ 0x5bd1e995).toString(16).padStart(8, "0")}"`;
};

function bucket(
	name: string,
	createdDaysAgo: number,
	files: [key: string, size: number, minutesAgo: number][],
	opts: { versioning?: boolean; access?: "private" | "public-read" } = {},
): MockBucket {
	return {
		name,
		createdAt: at(createdDaysAgo * 1440),
		versioning: opts.versioning ?? false,
		access: opts.access ?? "private",
		objects: new Map(
			files.map(([key, size, ago]) => [
				key,
				{
					key,
					size,
					lastModified: at(ago),
					etag: etag(),
					contentType: typeOf(key),
				},
			]),
		),
	};
}

const range = <T>(n: number, fn: (i: number) => T) =>
	Array.from({ length: n }, (_, i) => fn(i));
const pad = (n: number) => String(n).padStart(2, "0");

const CHAIRS = ["oak", "walnut", "ash", "beech", "cherry", "elm"];

function seedMedia(): Store {
	return {
		engine: "minio",
		accessKeyId: "LSQ7M2K4R8T1V5X9B3N6",
		buckets: [
			bucket(
				"product-images",
				210,
				[
					["README.md", 2.1 * KB, 60 * 24 * 40],
					["logo.svg", 6.4 * KB, 60 * 24 * 90],
					...CHAIRS.map((w, i): [string, number, number] => [
						`products/chairs/${w}-lounge-chair.jpg`,
						(1.4 + i * 0.37) * MB,
						60 * (3 + i * 9),
					]),
					...CHAIRS.map((w, i): [string, number, number] => [
						`products/chairs/${w}-lounge-chair@2x.webp`,
						(820 + i * 61) * KB,
						60 * (3 + i * 9),
					]),
					["products/tables/round-dining-table.jpg", 2.8 * MB, 60 * 26],
					["products/tables/extendable-oak-table.jpg", 3.1 * MB, 60 * 50],
					["products/tables/side-table-pair.png", 1.2 * MB, 60 * 72],
					["products/lamps/arc-floor-lamp.jpg", 1.9 * MB, 60 * 30],
					["products/lamps/pendant-linen.webp", 640 * KB, 60 * 31],
					["products/catalog.json", 48 * KB, 25],
					["banners/black-friday-2026.webp", 1.1 * MB, 60 * 5],
					["banners/spring-collection.webp", 980 * KB, 60 * 24 * 160],
					["banners/free-shipping.png", 410 * KB, 60 * 24 * 12],
					...range(240, (i): [string, number, number] => [
						`thumbnails/sku-${String(10_400 + i)}.webp`,
						(18 + ((i * 37) % 40)) * KB,
						60 * 24 * (i % 30) + i,
					]),
				],
				{ versioning: true },
			),
			bucket("exports", 120, [
				...range(12, (i): [string, number, number] => [
					`orders/2026/10/orders-2026-10-${pad(i * 2 + 1)}.json`,
					(220 + i * 31) * KB,
					60 * 24 * (33 - i * 2),
				]),
				["orders/2026/11/orders-2026-11-01.json", 301 * KB, 60 * 24 * 2],
				["orders/2026/11/orders-2026-11-02.json", 287 * KB, 60 * 24],
				["reports/weekly-sales-2026-w43.csv", 74 * KB, 60 * 24 * 9],
				["reports/weekly-sales-2026-w44.csv", 79 * KB, 60 * 24 * 2],
				["catalog.json", 1.3 * MB, 60 * 7],
			]),
			bucket("user-uploads", 180, [
				["returns/RMA-20931/photo-front.jpg", 3.4 * MB, 60 * 4],
				["returns/RMA-20931/photo-label.jpg", 2.2 * MB, 60 * 4],
				["returns/RMA-20944/notes.txt", 1.1 * KB, 60 * 2],
				["invoices/2026/INV-2026-0981.pdf", 182 * KB, 60 * 24 * 3],
				["invoices/2026/INV-2026-0982.pdf", 176 * KB, 60 * 24 * 2],
				["videos/unboxing-oak-lounge-chair.mp4", 1.84 * GB, 60 * 24 * 6],
				["backups/catalog-dump-2026-11-01.sql.gz", 4.27 * GB, 60 * 30],
			]),
			bucket(
				"static-assets",
				300,
				[
					["fonts/mona-sans-variable.woff2", 118 * KB, 60 * 24 * 80],
					["css/storefront.3f9a1c.css", 64 * KB, 60 * 24],
					["favicon.svg", 1.8 * KB, 60 * 24 * 200],
				],
				{ access: "public-read" },
			),
			bucket(
				"cdn-logs",
				60,
				range(9, (i): [string, number, number] => [
					`cloudflare/2026-10-${pad(23 + i)}.log`,
					(4.2 + i * 0.6) * MB,
					60 * 24 * (9 - i),
				]),
			),
			bucket("scratch", 2, []),
		],
		keys: [
			{
				id: "skey_web",
				name: "storefront web",
				accessKeyId: "LSW3B7N1C5X9Z2V6M8K4",
				buckets: ["product-images", "user-uploads"],
				access: "readwrite",
				createdAt: at(60 * 24 * 120),
			},
			{
				id: "skey_export",
				name: "analytics export",
				accessKeyId: "LSE8R2T6Y1U5I9O3P7A4",
				buckets: ["exports"],
				access: "read",
				createdAt: at(60 * 24 * 41),
			},
			{
				id: "skey_cdn",
				name: "cdn origin",
				accessKeyId: "LSC4D8F2G6H1J5K9L3Q7",
				buckets: ["static-assets"],
				access: "read",
				createdAt: at(60 * 24 * 300),
			},
		],
	};
}

function seedUploads(): Store {
	return {
		engine: "garage",
		accessKeyId: "GK3f9a1c7e2b8d4f6a0c5e9b1d",
		buckets: [
			bucket("cms-media", 44, [
				["projects/villa-bellavista/hero.jpg", 4.6 * MB, 60 * 72],
				["projects/villa-bellavista/living-room.jpg", 3.9 * MB, 60 * 72],
				["projects/villa-bellavista/plan.pdf", 2.4 * MB, 60 * 73],
				["projects/casa-lago/hero.jpg", 5.1 * MB, 60 * 24 * 20],
				["team/rossi-portrait.jpg", 1.3 * MB, 60 * 24 * 40],
			]),
			bucket("site-backups", 44, [
				["2026-11-02/cms.sqlite.gz", 38 * MB, 60 * 24],
				["2026-11-03/cms.sqlite.gz", 39 * MB, 60 * 2],
			]),
		],
		keys: [
			{
				id: "skey_cms",
				name: "cms",
				accessKeyId: "GK8b2d4f6a0c1e3a5c7e9b0d2f",
				buckets: ["cms-media"],
				access: "readwrite",
				createdAt: at(60 * 24 * 44),
			},
		],
	};
}

function seedArchive(): Store {
	return {
		engine: "seaweedfs",
		accessKeyId: "LSA1S5D9F3G7H2J6K0L4",
		buckets: [
			bucket(
				"clickhouse-parts",
				140,
				range(60, (i): [string, number, number] => [
					`events/202610_${i + 1}_${i + 1}_0/data.bin`,
					(120 + ((i * 53) % 900)) * KB,
					60 * 24 * (60 - i),
				]),
				{ versioning: true },
			),
			bucket("plausible-exports", 140, [
				["acme-retail.it/2026-10.csv", 12 * MB, 60 * 24 * 3],
				["studiorossi.it/2026-10.csv", 2.3 * MB, 60 * 24 * 3],
			]),
		],
		keys: [],
	};
}

function seedDatasets(): Store {
	return {
		engine: "rustfs",
		accessKeyId: "LSR9T3Y7U1I5O9P2A6S0",
		secretsForbidden: true,
		buckets: [
			bucket("training-sets", 12, [
				["support-tickets/v3/train.jsonl", 812 * MB, 60 * 24 * 4],
				["support-tickets/v3/eval.jsonl", 96 * MB, 60 * 24 * 4],
				["support-tickets/v3/schema.json", 3.2 * KB, 60 * 24 * 4],
			]),
			bucket("eval-results", 12, [
				["2026-11-01/summary.json", 14 * KB, 60 * 24 * 2],
				["2026-11-01/failures.txt", 220 * KB, 60 * 24 * 2],
			]),
		],
		keys: [],
	};
}

const SEEDS: Record<string, () => Store> = {
	svc_storefront_production_media: seedMedia,
	svc_rossi_production_uploads: seedUploads,
	svc_analytics_production_archive: seedArchive,
	"svc_llm-gateway_staging_datasets": seedDatasets,
};

const stores = new Map<string, Store>();

function storageService(id: string) {
	const s = db.services.find((x) => x.id === id);
	if (s?.spec.kind !== "storage")
		throw new ApiError(404, "Storage service not found", "not_found");
	return { service: s, engine: s.spec.engine };
}

function storeOf(id: string): Store {
	const { engine } = storageService(id);
	let store = stores.get(id);
	if (!store) {
		store = SEEDS[id]?.() ?? {
			engine,
			buckets: [],
			keys: [],
			accessKeyId: `LS${Math.random().toString(36).slice(2, 20).toUpperCase()}`,
		};
		stores.set(id, store);
	}
	return store;
}

function bucketOf(id: string, name: string) {
	const b = storeOf(id).buckets.find((x) => x.name === name);
	if (!b) throw new ApiError(404, `No bucket named ${name}`, "not_found");
	return b;
}

function objectOf(id: string, name: string, key: string) {
	const o = bucketOf(id, name).objects.get(key);
	if (!o) throw new ApiError(404, `No object at ${key}`, "not_found");
	return o;
}

/** Engines answer the S3 list call: folders are common prefixes at this level. */
function listLevel(b: MockBucket, prefix: string, cursor?: string): ObjectPage {
	const folders = new Set<string>();
	const objects: MockObject[] = [];
	for (const o of b.objects.values()) {
		if (!o.key.startsWith(prefix)) continue;
		const rest = o.key.slice(prefix.length);
		const slash = rest.indexOf("/");
		if (slash >= 0) folders.add(prefix + rest.slice(0, slash + 1));
		else if (rest) objects.push(o);
	}
	const entries = [
		...[...folders].sort().map((f) => ({ folder: f })),
		...objects
			.sort((x, y) => x.key.localeCompare(y.key))
			.map((o) => ({ object: o })),
	];
	const start = cursor ? Number(cursor) : 0;
	const page = entries.slice(start, start + PAGE);
	return {
		folders: page.flatMap((e) => ("folder" in e ? [e.folder] : [])),
		objects: page.flatMap((e) =>
			"object" in e
				? [
						{
							key: e.object.key,
							size: Math.round(e.object.size),
							lastModified: e.object.lastModified,
							etag: e.object.etag,
						},
					]
				: [],
		),
		nextCursor: start + PAGE < entries.length ? String(start + PAGE) : null,
	};
}

const HUES = [32, 145, 210, 260, 15, 95];

/** A drawn stand-in for a product photo: flat colour, a simple silhouette, the file name. */
function picture(key: string) {
	const name = key.split("/").pop() ?? key;
	const seed = [...name].reduce((a, c) => a + c.charCodeAt(0), 0);
	const h = HUES[seed % HUES.length] ?? 32;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900">
<rect width="1200" height="900" fill="hsl(${h} 22% 86%)"/>
<rect y="620" width="1200" height="280" fill="hsl(${h} 18% 78%)"/>
<rect x="430" y="300" width="340" height="250" rx="28" fill="hsl(${h} 30% 38%)"/>
<rect x="400" y="500" width="400" height="90" rx="22" fill="hsl(${h} 32% 30%)"/>
<rect x="430" y="585" width="22" height="120" fill="hsl(${h} 25% 22%)"/>
<rect x="748" y="585" width="22" height="120" fill="hsl(${h} 25% 22%)"/>
<text x="600" y="820" font-family="system-ui, sans-serif" font-size="30" fill="hsl(${h} 20% 32%)" text-anchor="middle">${name}</text>
</svg>`;
}

function body(o: MockObject): Blob {
	if (o.file) return o.file;
	const t = o.contentType;
	if (t.startsWith("image/"))
		return new Blob([picture(o.key)], { type: "image/svg+xml" });
	if (t === "application/json")
		return new Blob(
			[
				JSON.stringify(
					o.key.includes("orders")
						? {
								date: o.key.match(/\d{4}-\d{2}-\d{2}/)?.[0],
								count: 3,
								orders: [
									{ id: "ORD-58211", total: 249.0, currency: "EUR", items: 2 },
									{ id: "ORD-58212", total: 89.9, currency: "EUR", items: 1 },
									{ id: "ORD-58213", total: 1290.0, currency: "EUR", items: 4 },
								],
							}
						: {
								name: o.key,
								version: 3,
								generatedAt: o.lastModified,
								entries: 412,
								fields: ["sku", "title", "price", "stock", "images"],
							},
					null,
					2,
				),
			],
			{ type: t },
		);
	if (t.startsWith("text/"))
		return new Blob(
			[
				o.key.endsWith(".csv")
					? "day,sku,revenue,units\n2026-10-27,OAK-LC-01,4980.00,20\n2026-10-27,WAL-LC-01,3120.00,12\n2026-10-28,ARC-FL-02,1890.00,9\n"
					: o.key.endsWith(".md")
						? "# Product images\n\nOriginals live under products/. Thumbnails are regenerated nightly by the image worker.\n"
						: range(
								24,
								(i) =>
									`2026-11-02T0${i % 10}:1${i % 6}:0${i % 9}Z 200 GET /products/sku-${10_400 + i}.webp ${18 + i} KiB`,
							).join("\n"),
			],
			{ type: t },
		);
	return new Blob([`mock bytes of ${o.key}`], { type: t });
}

const fakeHex = (n: number) =>
	range(n, () => Math.floor(Math.random() * 16).toString(16)).join("");

function endpoints(id: string) {
	const { service, engine } = storageService(id);
	const def = STORAGE_ENGINES[engine];
	const [s3, consoleHost] = service.domains;
	return {
		publicEndpoint: s3 ? `https://${s3}` : null,
		consoleUrl:
			def.consolePort && consoleHost ? `https://${consoleHost}` : null,
	};
}

export const mockStorage: StorageApi = {
	list: () =>
		delay(
			db.services.flatMap((s): StorageListItem[] => {
				if (s.spec.kind !== "storage") return [];
				const env = db.environments.find((e) => e.id === s.environmentId);
				const project = db.projects.find((p) => p.id === env?.projectId);
				if (!env || !project) return [];
				return [
					{
						id: s.id,
						name: s.name,
						slug: s.slug,
						engine: s.spec.engine,
						projectId: project.id,
						projectName: project.name,
						environmentId: env.id,
						environmentName: env.name,
						observed: s.status.observed,
						createdAt: s.createdAt,
					},
				];
			}),
		),
	connection: (id) => {
		const store = storeOf(id);
		const { service } = storageService(id);
		const def = STORAGE_ENGINES[store.engine];
		return delay({
			engine: store.engine,
			version: def.version,
			region: "us-east-1",
			pathStyle: true as const,
			internalEndpoint: `http://${service.slug}:${def.s3Port}`,
			...endpoints(id),
			accessKeyId: store.accessKeyId,
			capabilities: {
				versioning: def.versioning,
				bucketPolicy: def.bucketPolicy,
				accessKeys: true,
				usage: def.usage,
				console: def.consolePort !== null,
			},
		});
	},
	credentials: async (id) => {
		const store = storeOf(id);
		if (store.secretsForbidden) {
			await delay(null);
			throw new ApiError(
				403,
				"You need read:secrets on this service",
				"forbidden",
			);
		}
		return delay({
			accessKeyId: store.accessKeyId,
			secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYmockSECRET",
		});
	},
	buckets: {
		list: (id) => {
			const store = storeOf(id);
			const def = STORAGE_ENGINES[store.engine];
			return delay(
				store.buckets.map((b): Bucket => {
					const objects = [...b.objects.values()];
					return {
						name: b.name,
						createdAt: b.createdAt,
						versioning: def.versioning ? b.versioning : null,
						access: def.bucketPolicy ? b.access : null,
						size: def.usage
							? Math.round(objects.reduce((a, o) => a + o.size, 0))
							: null,
						objects: def.usage ? objects.length : null,
					};
				}),
			);
		},
		create: async (id, name) => {
			const store = storeOf(id);
			if (store.buckets.some((b) => b.name === name)) {
				await delay(null);
				throw new ApiError(409, `A bucket named ${name} already exists`);
			}
			store.buckets.push(bucket(name, 0, []));
			store.buckets.sort((a, b) => a.name.localeCompare(b.name));
			await delay(null, 400);
		},
		update: async (id, name, patch) => {
			const b = bucketOf(id, name);
			if (patch.versioning !== undefined) b.versioning = patch.versioning;
			if (patch.access) b.access = patch.access;
			await delay(null, 350);
		},
		remove: async (id, name) => {
			const store = storeOf(id);
			bucketOf(id, name);
			store.buckets = store.buckets.filter((b) => b.name !== name);
			await delay(null, 700);
		},
	},
	objects: {
		list: (id, name, { prefix, cursor }) =>
			delay(listLevel(bucketOf(id, name), prefix, cursor)),
		head: (id, name, key) => {
			const o = objectOf(id, name, key);
			return delay({
				key,
				size: Math.round(o.size),
				contentType: o.contentType,
				etag: o.etag,
				lastModified: o.lastModified,
				metadata: (o.file ? {} : { "uploaded-by": "storefront-web" }) as Record<
					string,
					string
				>,
				s3Url: `s3://${name}/${key}`,
			});
		},
		fetch: (id, name, key) => delay(body(objectOf(id, name, key)), 300),
		downloadUrl: (id, name, key) => {
			const o = bucketOf(id, name).objects.get(key);
			return o ? URL.createObjectURL(body(o)) : "#";
		},
		upload: (id, name, key, file, onProgress) => {
			const b = bucketOf(id, name);
			// Roughly a fast LAN: big files take a few seconds, small ones are near instant.
			const duration = Math.min(
				9000,
				Math.max(1200, (file.size / (40 * MB)) * 1000),
			);
			const started = Date.now();
			let timer: ReturnType<typeof setInterval> | undefined;
			let reject: (e: unknown) => void = () => {};
			const done = new Promise<void>((resolve, fail) => {
				reject = fail;
				timer = setInterval(() => {
					const t = Math.min(1, (Date.now() - started) / duration);
					onProgress(Math.round(file.size * t));
					if (t < 1) return;
					clearInterval(timer);
					b.objects.set(key, {
						key,
						size: file.size,
						lastModified: new Date().toISOString(),
						etag: etag(),
						contentType: file.type || typeOf(key),
						file,
					});
					resolve();
				}, 120);
			});
			return {
				done,
				abort: () => {
					clearInterval(timer);
					reject(new DOMException("Cancelled", "AbortError"));
				},
			};
		},
		remove: async (id, name, keys) => {
			const b = bucketOf(id, name);
			for (const k of keys)
				for (const o of [...b.objects.keys()])
					if (k.endsWith("/") ? o.startsWith(k) : o === k) b.objects.delete(o);
			await delay(null, 400);
		},
		move: async (id, name, from, to) => {
			const b = bucketOf(id, name);
			const o = objectOf(id, name, from);
			if (b.objects.has(to)) {
				await delay(null);
				throw new ApiError(409, `${to} already exists`);
			}
			b.objects.delete(from);
			b.objects.set(to, {
				...o,
				key: to,
				lastModified: new Date().toISOString(),
			});
			await delay(null, 350);
		},
		share: (id, name, key, expiresIn) => {
			objectOf(id, name, key);
			const { publicEndpoint } = endpoints(id);
			const store = storeOf(id);
			const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
			return delay(
				publicEndpoint
					? {
							url: `${publicEndpoint}/${name}/${key.split("/").map(encodeURIComponent).join("/")}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=${store.accessKeyId}%2F20261103%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20261103T101500Z&X-Amz-Expires=${expiresIn}&X-Amz-SignedHeaders=host&X-Amz-Signature=${fakeHex(64)}`,
							expiresAt,
							via: "s3" as const,
						}
					: {
							url: `${location.origin}/api/storage/shared/v1.${fakeHex(48)}`,
							expiresAt,
							via: "logistack" as const,
						},
				350,
			);
		},
	},
	keys: {
		list: (id) => delay(storeOf(id).keys),
		create: (id, input) => {
			const store = storeOf(id);
			const key: AccessKey = {
				id: rid("skey"),
				name: input.name,
				accessKeyId:
					store.engine === "garage"
						? `GK${fakeHex(24)}`
						: `LS${range(18, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("")}`,
				buckets: [...new Set(input.buckets)],
				access: input.access,
				createdAt: new Date().toISOString(),
			};
			store.keys.unshift(key);
			return delay(
				{ ...key, secretAccessKey: `${fakeHex(20)}${fakeHex(20)}` },
				500,
			);
		},
		revoke: async (id, keyId) => {
			const store = storeOf(id);
			store.keys = store.keys.filter((k) => k.id !== keyId);
			await delay(null, 350);
		},
	},
	backupDestination: async (id, input) => {
		const store = storeOf(id);
		const name = input.bucket ?? "logistack-backups";
		if (!store.buckets.some((b) => b.name === name))
			store.buckets.push(bucket(name, 0, []));
		return delay({ id: rid("s3d") }, 600);
	},
};
