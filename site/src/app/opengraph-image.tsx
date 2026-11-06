import { ImageResponse } from "next/og";
import { ditherCells, hex } from "@/lib/dither";

export const dynamic = "force-static";
export const alt = "LogiStack, the open-source self-hosted PaaS";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const ARC = ditherCells(
	{
		shape: "arc",
		cell: 14,
		colors: [hex("#4FD08B"), hex("#4CC3D9"), hex("#3A66F0")],
		seed: 3,
	},
	1200,
	330,
);

export default function OpengraphImage() {
	return new ImageResponse(
		<div
			style={{
				width: "100%",
				height: "100%",
				display: "flex",
				flexDirection: "column",
				background: "#111214",
				color: "#F1F2F4",
				position: "relative",
			}}
		>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: 16,
					padding: "64px 72px 0",
				}}
			>
				<div
					style={{
						width: 44,
						height: 44,
						borderRadius: 11,
						background: "#F1F2F4",
						display: "flex",
						flexDirection: "column",
						justifyContent: "center",
						gap: 3,
						padding: "0 11px",
					}}
				>
					<div
						style={{
							width: 22,
							height: 5,
							borderRadius: 2,
							background: "#111214",
						}}
					/>
					<div
						style={{
							width: 16,
							height: 5,
							borderRadius: 2,
							background: "#111214",
						}}
					/>
					<div
						style={{
							width: 9,
							height: 5,
							borderRadius: 2,
							background: "#4FD08B",
						}}
					/>
				</div>
				<div style={{ fontSize: 34, fontWeight: 600, letterSpacing: -1 }}>
					LogiStack
				</div>
			</div>
			<div
				style={{
					display: "flex",
					padding: "44px 72px 0",
					fontSize: 76,
					lineHeight: 1,
					letterSpacing: -3,
					fontWeight: 600,
					maxWidth: 1000,
				}}
			>
				Self-host anything in one click.
			</div>
			<div
				style={{
					display: "flex",
					padding: "24px 72px 0",
					fontSize: 28,
					color: "#A7ABB3",
				}}
			>
				The open-source PaaS for your own servers.
			</div>
			<div
				style={{
					position: "absolute",
					left: 0,
					bottom: 0,
					width: 1200,
					height: 330,
					display: "flex",
				}}
			>
				{ARC.map((c) => (
					<div
						key={`${c.x}-${c.y}`}
						style={{
							position: "absolute",
							left: c.x + (14 - c.size) / 2,
							top: c.y + (14 - c.size) / 2,
							width: c.size,
							height: c.size,
							background: `rgb(${c.color.map(Math.round).join(",")})`,
						}}
					/>
				))}
			</div>
		</div>,
		size,
	);
}
