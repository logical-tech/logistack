import { site } from "@/content/site";
import { type Brand, BrandIcon } from "../brand-icon";
import { CopyCommand } from "../copy-command";
import { Dither } from "../dither";
import { Dot } from "../ui";

/** Position in % of the hero box, rotation in degrees, size in px; `wide` tiles only show from md up. */
const tiles: {
	brand: Brand;
	left: number;
	top: number;
	rotate: number;
	size: number;
	delay: number;
	wide?: boolean;
}[] = [
	{ brand: "postgres", left: 10, top: 16, rotate: -8, size: 76, delay: 0 },
	{
		brand: "libsql",
		left: 4,
		top: 40,
		rotate: 6,
		size: 64,
		delay: 1.2,
		wide: true,
	},
	{
		brand: "minio",
		left: 15,
		top: 60,
		rotate: -5,
		size: 68,
		delay: 2.1,
		wide: true,
	},
	{ brand: "redis", left: 84, top: 14, rotate: 7, size: 72, delay: 0.6 },
	{
		brand: "mongodb",
		left: 91,
		top: 39,
		rotate: -7,
		size: 76,
		delay: 1.8,
		wide: true,
	},
	{
		brand: "clickhouse",
		left: 80,
		top: 61,
		rotate: 5,
		size: 64,
		delay: 2.6,
		wide: true,
	},
	{
		brand: "mysql",
		left: 28,
		top: 4,
		rotate: -4,
		size: 56,
		delay: 0.9,
		wide: true,
	},
	{
		brand: "n8n",
		left: 69,
		top: 3,
		rotate: 6,
		size: 58,
		delay: 1.5,
		wide: true,
	},
];

export function Hero({ templates }: { templates: number }) {
	return (
		<section
			aria-labelledby="hero-title"
			className="relative isolate mx-auto w-full max-w-[1440px] overflow-hidden"
		>
			<div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
				{tiles.map((t) => (
					<div
						key={t.brand}
						className={`absolute ${t.wide ? "hidden md:block" : "hidden sm:block"}`}
						style={{
							left: `${t.left}%`,
							top: `${t.top}%`,
							rotate: `${t.rotate}deg`,
						}}
					>
						<div
							className="float-tile flex items-center justify-center bg-tile shadow-[0_16px_32px_-8px_rgb(0_0_0/0.6),inset_0_0_0_1px_rgb(255_255_255/0.06)]"
							style={{
								width: t.size,
								height: t.size,
								borderRadius: Math.round(t.size * 0.27),
								animationDelay: `-${t.delay}s`,
							}}
						>
							<BrandIcon name={t.brand} className="size-[46%]" />
						</div>
					</div>
				))}
			</div>

			<div className="mx-auto flex max-w-[920px] flex-col items-center px-4 pt-20 text-center sm:pt-[120px]">
				<h1
					id="hero-title"
					className="text-[42px] leading-[0.98] font-medium tracking-[-0.04em] sm:text-[72px] lg:text-[92px]"
				>
					Self-host anything in one click.
				</h1>
				<p
					className="rise mt-7 max-w-[40ch] text-lg leading-relaxed text-muted "
					style={{ animationDelay: "120ms" }}
				>
					Push a repository or pick one of {templates} templates. LogiStack
					builds it, gives it a domain with HTTPS, backs it up and shows you
					what every server is doing.
				</p>
				<div
					id="install"
					className="rise mt-9 flex w-full flex-col items-center gap-3 sm:w-auto sm:flex-row"
					style={{ animationDelay: "220ms" }}
				>
					<CopyCommand command={site.install} />
					<a
						href={`${site.github}#quick-start`}
						className="pressable inline-flex h-12 items-center gap-2 rounded-full px-5 text-sm font-medium hover:bg-tile"
					>
						Read the docs
						<svg
							viewBox="0 0 24 24"
							aria-hidden
							className="size-4"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<path d="M5 12h14M13 6l6 6-6 6" />
						</svg>
					</a>
				</div>
				<p className="mt-4 text-[13px] text-faint">
					Ubuntu 22.04+ or Debian 12+, 2 GB of RAM. Free and open source, Apache
					2.0.
				</p>
			</div>

			<div className="relative mt-10 h-[300px] sm:mt-4 sm:h-[400px]">
				<Dither
					shape="arc"
					cell={11}
					gain={1.05}
					seed={3}
					className="absolute inset-0 size-full"
				/>
				<div className="absolute inset-x-0 bottom-10 flex flex-col items-center gap-1.5 px-4 text-center sm:bottom-16">
					<p className="flex items-center gap-2 text-sm">
						<Dot />
						14 of 14 services match their desired state
					</p>
					<p className="text-[13px] text-faint">
						Checked 2 seconds ago on 3 servers
					</p>
				</div>
			</div>
		</section>
	);
}
