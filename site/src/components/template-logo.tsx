/** A template's logo on a light tile so dark marks stay visible; a monogram when the catalog has none. */
export function TemplateLogo({
	name,
	logo,
	size = "size-10",
	priority = false,
}: {
	name: string;
	logo?: string;
	size?: string;
	priority?: boolean;
}) {
	return (
		<span
			aria-hidden
			className={`@container flex ${size} shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-fg/[0.94]`}
		>
			{logo ? (
				<img
					src={`/${logo}`}
					alt=""
					loading={priority ? "eager" : "lazy"}
					decoding="async"
					className="size-[64%] object-contain"
				/>
			) : (
				<span className="text-[44cqi] leading-none font-semibold text-bg">
					{name.slice(0, 1).toUpperCase()}
				</span>
			)}
		</span>
	);
}
