import {
	siClickhouse,
	siMariadb,
	siMeilisearch,
	siMinio,
	siMongodb,
	siMysql,
	siN8n,
	siPostgresql,
	siRedis,
	siTurso,
} from "simple-icons";

/** Brand colours that disappear on a dark tile are lifted; the rest stay as the brand ships them. */
const BRANDS = {
	postgres: { icon: siPostgresql, color: "#7A9BF2" },
	libsql: { icon: siTurso, color: `#${siTurso.hex}` },
	minio: { icon: siMinio, color: "#E0566F" },
	redis: { icon: siRedis, color: `#${siRedis.hex}` },
	mysql: { icon: siMysql, color: "#6FA6D6" },
	mongodb: { icon: siMongodb, color: `#${siMongodb.hex}` },
	mariadb: { icon: siMariadb, color: "#D08A6E" },
	clickhouse: { icon: siClickhouse, color: `#${siClickhouse.hex}` },
	meilisearch: { icon: siMeilisearch, color: `#${siMeilisearch.hex}` },
	n8n: { icon: siN8n, color: `#${siN8n.hex}` },
} as const;

export type Brand = keyof typeof BRANDS;

export function BrandIcon({
	name,
	className,
}: {
	name: Brand;
	className?: string;
}) {
	const { icon, color } = BRANDS[name];
	return (
		<svg
			viewBox="0 0 24 24"
			role="img"
			aria-label={icon.title}
			className={className}
			fill={color}
		>
			<path d={icon.path} />
		</svg>
	);
}

export const brandTitle = (name: Brand) => BRANDS[name].icon.title;
