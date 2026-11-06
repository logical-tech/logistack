import { Section } from "../ui";

type Token = [text: string, tone: "key" | "str" | "num" | "note"];
const TONE = {
	key: "text-[#8FB3FA]",
	str: "text-[#7FD9A8]",
	num: "text-fg",
	note: "text-faint",
};
const lines: Token[][] = [
	[
		["project: ", "key"],
		["acme", "str"],
	],
	[["services:", "key"]],
	[["  api:", "key"]],
	[
		["    source: ", "key"],
		["github.com/acme/api", "str"],
		["   # builds on every push", "note"],
	],
	[
		["    replicas: ", "key"],
		["2", "num"],
	],
	[
		["    domains: ", "key"],
		["[api.acme.dev]", "str"],
	],
	[["    env:", "key"]],
	[
		["      DATABASE_URL: ", "key"],
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal manifest syntax shown to the reader
		["${{ db.url }}", "str"],
	],
	[["  db:", "key"]],
	[
		["    template: ", "key"],
		["postgres", "str"],
	],
	[
		["    backups: ", "key"],
		['{ cron: "0 3 * * *", keep: 14, to: r2 }', "str"],
	],
];

export function Manifest() {
	return (
		<Section label="manifest-title">
			<div className="grid items-center gap-12 lg:grid-cols-[1fr_440px] lg:gap-20">
				<figure className="order-2 overflow-hidden rounded-[20px] bg-deep lg:order-1">
					<figcaption className="flex justify-between gap-4 bg-step px-[22px] py-3.5">
						<code className="font-mono text-[13px]">logistack.yaml</code>
						<span className="text-[13px] text-faint">
							Apply with logistack apply
						</span>
					</figcaption>
					<pre className="overflow-x-auto px-[22px] pt-6 pb-7 font-mono text-[13px] leading-[1.75]">
						<code>
							{lines.map((tokens, i) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: static lines never reorder
								<span key={i} className="block">
									<span
										aria-hidden
										className="inline-block w-[34px] text-white/20 select-none"
									>
										{i + 1}
									</span>
									{tokens.map(([text, tone]) => (
										<span key={text} className={TONE[tone]}>
											{text}
										</span>
									))}
								</span>
							))}
						</code>
					</pre>
				</figure>
				<div className="order-1 flex flex-col gap-6 lg:order-2">
					<h2
						id="manifest-title"
						className="text-[40px] leading-[1.04] font-medium tracking-[-0.035em] sm:text-[56px]"
					>
						The whole project in one file.
					</h2>
					<p className="text-lg leading-relaxed text-fg/90">
						Export any project to YAML, keep it in Git and apply it to another
						server. The API, the CLI and the built-in MCP server read the same
						schema, so an AI agent can deploy for you and still has to show the
						diff first.
					</p>
				</div>
			</div>
		</Section>
	);
}
