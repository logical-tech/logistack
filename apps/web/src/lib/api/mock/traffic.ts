import type {
	MetricRange,
	TrafficOverview,
	TrafficPoint,
	TrafficReport,
} from "@logistack/contracts";
import type { TrafficApi } from "../traffic";

const delay = <T>(v: T) =>
	new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), 250));

const HOURS: Record<MetricRange, number> = {
	"1h": 1,
	"6h": 6,
	"24h": 24,
	"7d": 168,
	"30d": 720,
};
const STEP: Record<MetricRange, number> = {
	"1h": 60,
	"6h": 60,
	"24h": 300,
	"7d": 1800,
	"30d": 7200,
};

/** A diurnal curve with a little noise, peaking mid-afternoon UTC; deterministic per bucket. */
function series(range: MetricRange, scale = 1): TrafficPoint[] {
	const step = STEP[range];
	const to = Math.floor(Date.now() / (step * 1000)) * step * 1000;
	const from = to - HOURS[range] * 3_600_000;
	const out: TrafficPoint[] = [];
	for (let t = from; t <= to; t += step * 1000) {
		const hour = new Date(t).getUTCHours() + new Date(t).getUTCMinutes() / 60;
		const noise = 0.85 + 0.3 * Math.abs(Math.sin(t / 7_919_000));
		const rps =
			scale *
			(4 + 14 * Math.max(0, Math.sin(((hour - 8) / 24) * 2 * Math.PI))) *
			noise;
		const requests = Math.round(rps * step);
		const s5 = Math.round(requests * (t % 13 === 0 ? 0.04 : 0.002));
		const s4 = Math.round(requests * 0.018);
		const s3 = Math.round(requests * 0.06);
		out.push({
			t,
			requests,
			rps: requests / step,
			s2: requests - s3 - s4 - s5,
			s3,
			s4,
			s5,
			bytesOut: requests * 18_400,
			pageviews: Math.round(requests * 0.21),
			p50: Math.round((38 + rps * 0.9) * 10) / 10,
			p95: Math.round((140 + rps * 6) * 10) / 10,
			p99: Math.round((320 + rps * 14) * 10) / 10,
		});
	}
	return out;
}

const ranked = (rows: [string, number][], f: number) =>
	rows.map(([key, n]) => ({ key, count: Math.round(n * f) }));

export const mockTraffic: TrafficApi = {
	report(_id, range) {
		const s = series(range);
		const sum = (k: keyof TrafficPoint) =>
			s.reduce((a, p) => a + Number(p[k] ?? 0), 0);
		const requests = sum("requests");
		const f = requests / 100_000;
		const report: TrafficReport = {
			range,
			step: STEP[range],
			totals: {
				requests,
				visitors: Math.round(requests * 0.034),
				pageviews: sum("pageviews"),
				bots: Math.round(requests * 0.07),
				bytesIn: requests * 900,
				bytesOut: sum("bytesOut"),
				status: [0, sum("s2"), sum("s3"), sum("s4"), sum("s5")],
				p50: 46.2,
				p95: 212.5,
				p99: 488.1,
			},
			series: s,
			paths: ranked(
				[
					["/", 21_400],
					["/products", 9_800],
					["/api/cart", 7_300],
					["/products/linen-shirt", 4_100],
					["/checkout", 2_300],
					["/api/search", 1_900],
					["/about", 740],
				],
				f,
			),
			referrers: ranked(
				[
					["google.com", 6_200],
					["news.ycombinator.com", 1_400],
					["duckduckgo.com", 610],
					["github.com", 380],
					["t.co", 220],
				],
				f,
			),
			countries: ranked(
				[
					["IT", 8_800],
					["DE", 4_100],
					["US", 3_900],
					["FR", 1_700],
					["GB", 1_200],
					["NL", 640],
				],
				f,
			),
			utmSources: ranked(
				[
					["newsletter", 820],
					["mastodon", 140],
				],
				f,
			),
			events: ranked(
				[
					["add_to_cart", 1_250],
					["checkout_started", 430],
					["signup", 96],
				],
				f,
			),
			domains: [
				{ id: "dom_shop", hostname: "shop.example.com", webAnalytics: true },
				{
					id: "dom_www",
					hostname: "www.shop.example.com",
					webAnalytics: false,
				},
			],
		};
		return delay(report);
	},
	overview(range) {
		const report: TrafficOverview = {
			range,
			step: STEP[range],
			series: series(range, 2.6),
			services: [
				["svc_storefront_production_web", "web", 1, 0.002, 212],
				["svc_storefront_production_api", "api", 0.7, 0.011, 96],
				["svc_booking_production_api", "api", 0.35, 0.0004, 74],
				["svc_llm-gateway_staging_gateway", "gateway", 0.05, 0.031, 1_840],
			].map(([serviceId, name, share, errorRate, p95]) => {
				const requests = Math.round(
					series(range).reduce((a, p) => a + p.requests, 0) * Number(share),
				);
				return {
					serviceId: String(serviceId),
					name: String(name),
					projectId: `prj_${String(serviceId).split("_")[1]}`,
					project: String(serviceId).split("_")[1] ?? "",
					requests,
					visitors: Math.round(requests * 0.03),
					errorRate: Number(errorRate),
					p95: Number(p95),
				};
			}),
		};
		return delay(report);
	},
	setWebAnalytics: (id, enabled) => delay({ id, webAnalytics: enabled }),
};
