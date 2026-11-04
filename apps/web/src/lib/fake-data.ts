/*
 * Test data, Mockaroo-style, generated in the browser with Faker: a catalogue of generators,
 * a suggestion per column from its name and type, and preset datasets with their tables.
 * Faker is loaded on demand, so none of this weighs on the explorer until it is used.
 */

import type { Faker } from "@faker-js/faker";
import type { Cell, DbColumn } from "@logistack/contracts";

export const LOCALES = {
	en: { label: "English", load: () => import("@faker-js/faker/locale/en") },
	it: { label: "Italiano", load: () => import("@faker-js/faker/locale/it") },
	de: { label: "Deutsch", load: () => import("@faker-js/faker/locale/de") },
	fr: { label: "Français", load: () => import("@faker-js/faker/locale/fr") },
	es: { label: "Español", load: () => import("@faker-js/faker/locale/es") },
} as const;
export type Locale = keyof typeof LOCALES;

export const loadFaker = async (locale: Locale) =>
	(await LOCALES[locale].load()).faker;

/** What a generator sees per row: its index, the row so far, and the column it fills. */
export type GenContext = {
	i: number;
	row: Record<string, Cell>;
	column: Pick<DbColumn, "name" | "type">;
};

export type Generator = {
	id: string;
	label: string;
	group: string;
	make: (f: Faker, ctx: GenContext) => Cell;
};

const pad = (n: number) => String(n).padStart(2, "0");
/** `YYYY-MM-DD HH:MM:SS`: what Postgres, MySQL and SQLite all parse as a timestamp. */
export const sqlTimestamp = (d: Date) =>
	`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
const sqlDate = (d: Date) => sqlTimestamp(d).slice(0, 10);

/** A date in the column's own shape: a date column gets no time. */
const when = (d: Date, c: GenContext) =>
	/^date$/i.test(c.column.type.trim()) ? sqlDate(d) : sqlTimestamp(d);

/** Booleans as the column stores them: real booleans, or 0/1 for MySQL tinyint and SQLite. */
const flag = (b: boolean, c: GenContext): Cell =>
	/bool/i.test(c.column.type) ? b : b ? 1 : 0;

const first = (f: Faker, c: GenContext) =>
	String(c.row.first_name ?? c.row.firstname ?? f.person.firstName());
const last = (f: Faker, c: GenContext) =>
	String(c.row.last_name ?? c.row.lastname ?? f.person.lastName());
const slug = (s: string) =>
	s
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ".")
		.replace(/^\.|\.$/g, "");

export const GENERATORS: Generator[] = [
	// Person
	{
		id: "first_name",
		label: "First name",
		group: "Person",
		make: (f) => f.person.firstName(),
	},
	{
		id: "last_name",
		label: "Last name",
		group: "Person",
		make: (f) => f.person.lastName(),
	},
	{
		id: "full_name",
		label: "Full name",
		group: "Person",
		make: (f, c) =>
			c.row.first_name || c.row.last_name
				? `${first(f, c)} ${last(f, c)}`
				: f.person.fullName(),
	},
	{
		id: "email",
		label: "Email",
		group: "Person",
		// The row index keeps it unique, since columns like this often carry a unique index.
		make: (f, c) =>
			`${slug(`${first(f, c)}.${last(f, c)}`)}${c.i + 1}@${f.internet.domainName()}`,
	},
	{
		id: "username",
		label: "Username",
		group: "Person",
		make: (f, c) => `${slug(f.internet.username())}${c.i + 1}`,
	},
	{
		id: "phone",
		label: "Phone",
		group: "Person",
		make: (f) => f.phone.number(),
	},
	{
		id: "job_title",
		label: "Job title",
		group: "Person",
		make: (f) => f.person.jobTitle(),
	},
	{
		id: "gender",
		label: "Gender",
		group: "Person",
		make: (f) => f.person.sex(),
	},
	{
		id: "birthdate",
		label: "Birthdate",
		group: "Person",
		make: (f, c) =>
			when(f.date.birthdate({ min: 18, max: 80, mode: "age" }), c),
	},
	{
		id: "avatar",
		label: "Avatar URL",
		group: "Person",
		make: (f) => f.image.avatar(),
	},
	{ id: "bio", label: "Bio", group: "Person", make: (f) => f.person.bio() },
	// Location
	{
		id: "street",
		label: "Street address",
		group: "Location",
		make: (f) => f.location.streetAddress(),
	},
	{
		id: "city",
		label: "City",
		group: "Location",
		make: (f) => f.location.city(),
	},
	{
		id: "zip",
		label: "Postal code",
		group: "Location",
		make: (f) => f.location.zipCode(),
	},
	{
		id: "state",
		label: "State or region",
		group: "Location",
		make: (f) => f.location.state(),
	},
	{
		id: "country",
		label: "Country",
		group: "Location",
		make: (f) => f.location.country(),
	},
	{
		id: "country_code",
		label: "Country code",
		group: "Location",
		make: (f) => f.location.countryCode(),
	},
	{
		id: "latitude",
		label: "Latitude",
		group: "Location",
		make: (f) => f.location.latitude(),
	},
	{
		id: "longitude",
		label: "Longitude",
		group: "Location",
		make: (f) => f.location.longitude(),
	},
	// Company and commerce
	{
		id: "company",
		label: "Company",
		group: "Business",
		make: (f) => f.company.name(),
	},
	{
		id: "department",
		label: "Department",
		group: "Business",
		make: (f) => f.commerce.department(),
	},
	{
		id: "product",
		label: "Product name",
		group: "Business",
		make: (f) => f.commerce.productName(),
	},
	{
		id: "product_description",
		label: "Product description",
		group: "Business",
		make: (f) => f.commerce.productDescription(),
	},
	{
		id: "price",
		label: "Price",
		group: "Business",
		make: (f) => Number(f.commerce.price({ min: 1, max: 500, dec: 2 })),
	},
	{
		id: "sku",
		label: "SKU",
		group: "Business",
		make: (f, c) =>
			`${f.string.alpha({ length: 3, casing: "upper" })}-${1000 + c.i}`,
	},
	{
		id: "currency",
		label: "Currency code",
		group: "Business",
		make: (f) => f.finance.currencyCode(),
	},
	{
		id: "iban",
		label: "IBAN",
		group: "Business",
		make: (f) => f.finance.iban(),
	},
	{
		id: "order_status",
		label: "Order status",
		group: "Business",
		make: (f) =>
			f.helpers.arrayElement([
				"pending",
				"paid",
				"shipped",
				"delivered",
				"cancelled",
			]),
	},
	// Internet
	{ id: "url", label: "URL", group: "Internet", make: (f) => f.internet.url() },
	{
		id: "domain",
		label: "Domain",
		group: "Internet",
		make: (f) => f.internet.domainName(),
	},
	{
		id: "ip",
		label: "IPv4 address",
		group: "Internet",
		make: (f) => f.internet.ipv4(),
	},
	{
		id: "user_agent",
		label: "User agent",
		group: "Internet",
		make: (f) => f.internet.userAgent(),
	},
	{
		id: "image_url",
		label: "Image URL",
		group: "Internet",
		make: (f) => f.image.url(),
	},
	{
		id: "color",
		label: "Hex color",
		group: "Internet",
		make: (f) => f.color.rgb(),
	},
	// Text
	{ id: "word", label: "Word", group: "Text", make: (f) => f.lorem.word() },
	{
		id: "title",
		label: "Title",
		group: "Text",
		make: (f) => f.lorem.sentence({ min: 3, max: 7 }).replace(/\.$/, ""),
	},
	{
		id: "sentence",
		label: "Sentence",
		group: "Text",
		make: (f) => f.lorem.sentence(),
	},
	{
		id: "paragraph",
		label: "Paragraph",
		group: "Text",
		make: (f) => f.lorem.paragraph(),
	},
	{
		id: "slug",
		label: "Slug",
		group: "Text",
		make: (f, c) => `${f.lorem.slug(3)}-${c.i + 1}`,
	},
	{
		id: "tag",
		label: "Tag",
		group: "Text",
		make: (f) =>
			f.helpers.arrayElement([
				"news",
				"guide",
				"release",
				"tips",
				"case-study",
				"opinion",
			]),
	},
	// Numbers and ids
	{
		id: "uuid",
		label: "UUID",
		group: "Numbers and ids",
		make: (f) => f.string.uuid(),
	},
	{
		id: "int_small",
		label: "Integer 1–100",
		group: "Numbers and ids",
		make: (f) => f.number.int({ min: 1, max: 100 }),
	},
	{
		id: "int_large",
		label: "Integer 1–1,000,000",
		group: "Numbers and ids",
		make: (f) => f.number.int({ min: 1, max: 1_000_000 }),
	},
	{
		id: "quantity",
		label: "Quantity 1–10",
		group: "Numbers and ids",
		make: (f) => f.number.int({ min: 1, max: 10 }),
	},
	{
		id: "rating",
		label: "Rating 1–5",
		group: "Numbers and ids",
		make: (f) => f.number.int({ min: 1, max: 5 }),
	},
	{
		id: "decimal",
		label: "Decimal 0–1000",
		group: "Numbers and ids",
		make: (f) => f.number.float({ min: 0, max: 1000, fractionDigits: 2 }),
	},
	{
		id: "percent",
		label: "Percent 0–100",
		group: "Numbers and ids",
		make: (f) => f.number.float({ min: 0, max: 100, fractionDigits: 1 }),
	},
	{
		id: "row_number",
		label: "Row number",
		group: "Numbers and ids",
		make: (_f, c) => c.i + 1,
	},
	// Dates
	{
		id: "past",
		label: "Past date (2 years)",
		group: "Dates",
		make: (f, c) => when(f.date.past({ years: 2 }), c),
	},
	{
		id: "recent",
		label: "Recent date (30 days)",
		group: "Dates",
		make: (f, c) => when(f.date.recent({ days: 30 }), c),
	},
	{
		id: "future",
		label: "Future date (1 year)",
		group: "Dates",
		make: (f, c) => when(f.date.future({ years: 1 }), c),
	},
	{
		id: "after_created",
		label: "After created_at",
		group: "Dates",
		make: (f, c) => {
			const from =
				typeof c.row.created_at === "string"
					? new Date(`${c.row.created_at.replace(" ", "T")}Z`)
					: f.date.past();
			return when(f.date.between({ from, to: new Date() }), c);
		},
	},
	// Logic
	{
		id: "boolean",
		label: "Boolean",
		group: "Logic",
		make: (f, c) => flag(f.datatype.boolean(), c),
	},
	{
		id: "mostly_true",
		label: "Boolean, mostly true",
		group: "Logic",
		make: (f, c) => flag(f.datatype.boolean({ probability: 0.85 }), c),
	},
	{
		id: "json",
		label: "JSON object",
		group: "Logic",
		make: (f) => ({
			type: "json",
			value: JSON.stringify({
				source: f.helpers.arrayElement(["web", "ios", "android"]),
				score: f.number.int(100),
			}),
		}),
	},
	{ id: "null", label: "Always NULL", group: "Logic", make: () => null },
];

export const generatorById = new Map(GENERATORS.map((g) => [g.id, g]));

/** Leave the column to its default: identities, serials, autoincrement keys. */
export const AUTO = "auto";
/** Pick a value from the referenced table's key. */
export const REFERENCE = "reference";

const BY_NAME: [RegExp, string][] = [
	[/^(first_?name|given_?name|nome)$/, "first_name"],
	[/^(last_?name|surname|family_?name|cognome)$/, "last_name"],
	[/^(full_?name|name|display_?name|author|customer_?name)$/, "full_name"],
	[/e_?mail/, "email"],
	[/^(user_?name|login|handle|nickname)$/, "username"],
	[/phone|mobile|tel/, "phone"],
	[/job|title_?job|position|role/, "job_title"],
	[/gender|sex/, "gender"],
	[/birth|dob/, "birthdate"],
	[/avatar|photo|picture/, "avatar"],
	[/^bio$|about/, "bio"],
	[/street|address|indirizzo/, "street"],
	[/city|town|citta/, "city"],
	[/zip|postal|post_?code|cap$/, "zip"],
	[/^(state|region|province)$/, "state"],
	[/country_?code|^iso/, "country_code"],
	[/country|nation/, "country"],
	[/^lat(itude)?$/, "latitude"],
	[/^(lng|lon|long|longitude)$/, "longitude"],
	[/company|organi[sz]ation|employer/, "company"],
	[/department/, "department"],
	[/^product(_?name)?$/, "product"],
	[/price|amount|cost|total|subtotal|balance/, "price"],
	[/sku|code$/, "sku"],
	[/currency/, "currency"],
	[/iban/, "iban"],
	[/status|state$/, "order_status"],
	[/url|link|website|homepage/, "url"],
	[/domain|host/, "domain"],
	[/ip(_?address)?$/, "ip"],
	[/user_?agent/, "user_agent"],
	[/image|cover|thumbnail|logo/, "image_url"],
	[/colou?r/, "color"],
	[/slug/, "slug"],
	[/^tags?$|category|label/, "tag"],
	[/uuid|guid|token/, "uuid"],
	[/qty|quantity|count|stock/, "quantity"],
	[/rating|stars|score/, "rating"],
	[/percent|ratio|discount/, "percent"],
	[/^(title|subject|headline|heading)$/, "title"],
	[/description|summary|excerpt|comment|note|message/, "sentence"],
	[/body|content|text/, "paragraph"],
	[
		/^(updated|modified|shipped|delivered|paid|published|completed)(_at|_on)?$/,
		"after_created",
	],
	[/created|registered|joined|signed_?up/, "past"],
	[/(due|expires?|ends?|scheduled)(_at|_on)?$/, "future"],
	[/(_at|_on|date|time)$/, "recent"],
	[
		/^(is|has|can)_|active|enabled|verified|published|visible|deleted/,
		"boolean",
	],
	[/meta|data|payload|settings|attributes|json/, "json"],
];

/** The generator a column most likely wants, from its name, then its type. */
export function suggest(
	column: Pick<DbColumn, "name" | "type" | "primaryKey" | "default">,
	opts: { reference?: boolean; singleKey?: boolean } = {},
): string {
	const name = column.name.toLowerCase();
	const type = column.type.toLowerCase();
	if (opts.reference) return REFERENCE;
	if (column.primaryKey && opts.singleKey && /int|serial|number/.test(type))
		return AUTO;
	if (
		column.default &&
		/nextval|identity|auto_increment|uuid|now\(|current_/.test(
			column.default.toLowerCase(),
		)
	)
		return AUTO;
	if (/uuid/.test(type)) return "uuid";
	if (/bool/.test(type) || type === "tinyint(1)") return "boolean";
	if (/json/.test(type)) return "json";
	const max = maxLength(type);
	if (max !== null && max <= 3 && /country|nation|lang|iso|code/.test(name))
		return "country_code";
	for (const [re, id] of BY_NAME) if (re.test(name)) return id;
	if (/timestamp|datetime/.test(type)) return "past";
	if (/^date/.test(type)) return "past";
	if (/numeric|decimal|real|double|float|money/.test(type)) return "decimal";
	if (/int|serial/.test(type)) return "int_small";
	if (/text|clob/.test(type)) return "sentence";
	return "word";
}

/** The n of `char(n)`, `varchar(n)`, `character varying(n)`; null when the type has no limit. */
export const maxLength = (type: string) => {
	const m = /char[a-z ]*\((\d+)\)/i.exec(type);
	return m ? Number(m[1]) : null;
};

export type ColumnPlan = {
	name: string;
	type: string;
	generator: string;
	/** Share of rows left NULL, 0 to 100. */
	nulls: number;
};

/**
 * Builds `count` rows from the plan; `refs` holds the key values a REFERENCE column picks
 * from. AUTO columns are left out so the database fills them.
 */
export function generateRows(
	f: Faker,
	plan: ColumnPlan[],
	count: number,
	refs: Record<string, Cell[]> = {},
	offset = 0,
): Record<string, Cell>[] {
	const rows: Record<string, Cell>[] = [];
	for (let i = 0; i < count; i++) {
		const row: Record<string, Cell> = {};
		for (const p of plan) {
			if (p.generator === AUTO) continue;
			if (p.nulls > 0 && f.number.int(99) < p.nulls) {
				row[p.name] = null;
				continue;
			}
			if (p.generator === REFERENCE) {
				const pool = refs[p.name] ?? [];
				row[p.name] = pool.length ? f.helpers.arrayElement(pool) : null;
				continue;
			}
			const g = generatorById.get(p.generator);
			const v = g ? g.make(f, { i: offset + i, row, column: p }) : null;
			const max = maxLength(p.type);
			// A longer value would fail the whole batch on a fixed-width column.
			row[p.name] = typeof v === "string" && max !== null ? v.slice(0, max) : v;
		}
		rows.push(row);
	}
	return rows;
}

// Presets

export type SqlDialect = "postgres" | "mysql" | "sqlite";
type ColType =
	| "id"
	| "ref"
	| "string"
	| "text"
	| "int"
	| "decimal"
	| "bool"
	| "timestamp"
	| "date"
	| "uuid";

export type PresetColumn = {
	name: string;
	type: ColType;
	generator: string;
	nullable?: boolean;
	/** Another table of the preset this column points at, by its `id`. */
	references?: string;
	nulls?: number;
};

export type PresetTable = {
	name: string;
	rows: number;
	columns: PresetColumn[];
};

export type Preset = {
	id: string;
	label: string;
	description: string;
	/** Parents first: each table only references tables before it. */
	tables: PresetTable[];
};

const id: PresetColumn = { name: "id", type: "id", generator: AUTO };
const createdAt: PresetColumn = {
	name: "created_at",
	type: "timestamp",
	generator: "past",
};

export const PRESETS: Preset[] = [
	{
		id: "users",
		label: "Users",
		description:
			"People with emails, phones and addresses, the classic sign-up table.",
		tables: [
			{
				name: "users",
				rows: 200,
				columns: [
					id,
					{ name: "first_name", type: "string", generator: "first_name" },
					{ name: "last_name", type: "string", generator: "last_name" },
					{ name: "email", type: "string", generator: "email" },
					{
						name: "phone",
						type: "string",
						generator: "phone",
						nullable: true,
						nulls: 15,
					},
					{ name: "city", type: "string", generator: "city" },
					{ name: "country", type: "string", generator: "country" },
					{ name: "is_active", type: "bool", generator: "mostly_true" },
					createdAt,
				],
			},
		],
	},
	{
		id: "shop",
		label: "E-commerce",
		description:
			"Customers, products, orders and their line items, linked by foreign keys.",
		tables: [
			{
				name: "customers",
				rows: 150,
				columns: [
					id,
					{ name: "full_name", type: "string", generator: "full_name" },
					{ name: "email", type: "string", generator: "email" },
					{ name: "street", type: "string", generator: "street" },
					{ name: "city", type: "string", generator: "city" },
					{ name: "country", type: "string", generator: "country" },
					createdAt,
				],
			},
			{
				name: "products",
				rows: 60,
				columns: [
					id,
					{ name: "sku", type: "string", generator: "sku" },
					{ name: "name", type: "string", generator: "product" },
					{
						name: "description",
						type: "text",
						generator: "product_description",
					},
					{ name: "price", type: "decimal", generator: "price" },
					{ name: "stock", type: "int", generator: "int_small" },
					createdAt,
				],
			},
			{
				name: "orders",
				rows: 400,
				columns: [
					id,
					{
						name: "customer_id",
						type: "ref",
						generator: REFERENCE,
						references: "customers",
					},
					{ name: "status", type: "string", generator: "order_status" },
					{ name: "total", type: "decimal", generator: "price" },
					createdAt,
					{ name: "updated_at", type: "timestamp", generator: "after_created" },
				],
			},
			{
				name: "order_items",
				rows: 1000,
				columns: [
					id,
					{
						name: "order_id",
						type: "ref",
						generator: REFERENCE,
						references: "orders",
					},
					{
						name: "product_id",
						type: "ref",
						generator: REFERENCE,
						references: "products",
					},
					{ name: "quantity", type: "int", generator: "quantity" },
					{ name: "unit_price", type: "decimal", generator: "price" },
				],
			},
		],
	},
	{
		id: "blog",
		label: "Blog",
		description:
			"Authors, posts and comments with titles, slugs and paragraphs.",
		tables: [
			{
				name: "authors",
				rows: 20,
				columns: [
					id,
					{ name: "name", type: "string", generator: "full_name" },
					{ name: "email", type: "string", generator: "email" },
					{
						name: "bio",
						type: "text",
						generator: "bio",
						nullable: true,
						nulls: 30,
					},
					{ name: "avatar_url", type: "string", generator: "avatar" },
				],
			},
			{
				name: "posts",
				rows: 120,
				columns: [
					id,
					{
						name: "author_id",
						type: "ref",
						generator: REFERENCE,
						references: "authors",
					},
					{ name: "title", type: "string", generator: "title" },
					{ name: "slug", type: "string", generator: "slug" },
					{ name: "body", type: "text", generator: "paragraph" },
					{ name: "is_published", type: "bool", generator: "mostly_true" },
					{ name: "published_at", type: "timestamp", generator: "past" },
				],
			},
			{
				name: "comments",
				rows: 600,
				columns: [
					id,
					{
						name: "post_id",
						type: "ref",
						generator: REFERENCE,
						references: "posts",
					},
					{ name: "author_name", type: "string", generator: "full_name" },
					{ name: "body", type: "text", generator: "sentence" },
					createdAt,
				],
			},
		],
	},
	{
		id: "projects",
		label: "Projects and tasks",
		description:
			"Companies, their projects and the tasks inside them, with due dates.",
		tables: [
			{
				name: "companies",
				rows: 25,
				columns: [
					id,
					{ name: "name", type: "string", generator: "company" },
					{ name: "website", type: "string", generator: "url" },
					{ name: "country", type: "string", generator: "country" },
				],
			},
			{
				name: "projects",
				rows: 80,
				columns: [
					id,
					{
						name: "company_id",
						type: "ref",
						generator: REFERENCE,
						references: "companies",
					},
					{ name: "name", type: "string", generator: "title" },
					{ name: "budget", type: "decimal", generator: "decimal" },
					{ name: "due_on", type: "date", generator: "future" },
				],
			},
			{
				name: "tasks",
				rows: 500,
				columns: [
					id,
					{
						name: "project_id",
						type: "ref",
						generator: REFERENCE,
						references: "projects",
					},
					{ name: "title", type: "string", generator: "title" },
					{ name: "description", type: "text", generator: "sentence" },
					{ name: "priority", type: "int", generator: "rating" },
					{ name: "is_done", type: "bool", generator: "boolean" },
					createdAt,
				],
			},
		],
	},
	{
		id: "events",
		label: "Analytics events",
		description:
			"A wide event log: sessions, pages, user agents and IPs, for query practice.",
		tables: [
			{
				name: "events",
				rows: 2000,
				columns: [
					id,
					{ name: "session_id", type: "uuid", generator: "uuid" },
					{ name: "name", type: "string", generator: "tag" },
					{ name: "url", type: "string", generator: "url" },
					{ name: "ip", type: "string", generator: "ip" },
					{ name: "user_agent", type: "text", generator: "user_agent" },
					{ name: "country_code", type: "string", generator: "country_code" },
					{ name: "duration_ms", type: "int", generator: "int_large" },
					{ name: "occurred_at", type: "timestamp", generator: "recent" },
				],
			},
		],
	},
];

const TYPES: Record<SqlDialect, Record<ColType, string>> = {
	postgres: {
		id: "bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY",
		ref: "bigint",
		string: "text",
		text: "text",
		int: "integer",
		decimal: "numeric(12, 2)",
		bool: "boolean",
		timestamp: "timestamp",
		date: "date",
		uuid: "uuid",
	},
	mysql: {
		id: "BIGINT AUTO_INCREMENT PRIMARY KEY",
		ref: "BIGINT",
		string: "varchar(255)",
		text: "text",
		int: "int",
		decimal: "decimal(12, 2)",
		bool: "tinyint(1)",
		timestamp: "datetime",
		date: "date",
		uuid: "char(36)",
	},
	sqlite: {
		id: "INTEGER PRIMARY KEY",
		ref: "INTEGER",
		string: "TEXT",
		text: "TEXT",
		int: "INTEGER",
		decimal: "NUMERIC",
		bool: "INTEGER",
		timestamp: "TEXT",
		date: "TEXT",
		uuid: "TEXT",
	},
};

export const quoteIdent = (d: SqlDialect, name: string) =>
	d === "mysql"
		? `\`${name.replaceAll("`", "``")}\``
		: `"${name.replaceAll('"', '""')}"`;

/** CREATE TABLE statements for a preset, parents first, with `prefix` on every table name. */
export function presetDdl(
	p: Preset,
	d: SqlDialect,
	schema: string | null,
	prefix = "",
): string {
	const q = (n: string) => quoteIdent(d, n);
	const table = (n: string) =>
		schema && d !== "sqlite" ? `${q(schema)}.${q(prefix + n)}` : q(prefix + n);
	// MySQL ignores an inline REFERENCES; a table-level constraint works everywhere.
	return p.tables
		.map((t) => {
			const lines = t.columns.map(
				(c) =>
					`  ${q(c.name)} ${TYPES[d][c.type]}${c.type === "id" || c.nullable ? "" : " NOT NULL"}`,
			);
			for (const c of t.columns)
				if (c.references)
					lines.push(
						`  FOREIGN KEY (${q(c.name)}) REFERENCES ${table(c.references)} (${q("id")})`,
					);
			return `CREATE TABLE ${table(t.name)} (\n${lines.join(",\n")}\n);`;
		})
		.join("\n\n");
}

/** DROP TABLE statements for a preset, children first, to undo a fill that failed half-way. */
export function presetDropSql(
	p: Preset,
	d: SqlDialect,
	schema: string | null,
	prefix = "",
): string {
	const q = (n: string) => quoteIdent(d, n);
	return [...p.tables]
		.reverse()
		.map(
			(t) =>
				`DROP TABLE IF EXISTS ${schema && d !== "sqlite" ? `${q(schema)}.` : ""}${q(prefix + t.name)};`,
		)
		.join("\n");
}
