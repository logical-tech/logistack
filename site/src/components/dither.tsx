"use client";

import { useEffect, useRef } from "react";
import { type DitherSpec, ditherCells, hex, type Shape } from "@/lib/dither";

const RAMPS = {
	brand: ["#4FD08B", "#4CC3D9", "#3A66F0"],
	cobalt: ["#2F4A8F", "#3A66F0", "#4CC3D9"],
	blue: ["#6E9CF7", "#6E9CF7", "#4CC3D9"],
	green: ["#4FD08B", "#4FD08B", "#4CC3D9"],
	sky: ["#4CC3D9", "#6E9CF7", "#3A66F0"],
	mint: ["#4FD08B", "#4CC3D9", "#4CC3D9"],
	grass: ["#4FD08B", "#4FD08B", "#6E9CF7"],
	indigo: ["#6E9CF7", "#3A66F0", "#3A66F0"],
	bridge: ["#6B7079", "#4CC3D9", "#4FD08B"],
	sponsor: ["#F2779A", "#E8B54A", "#F2779A"],
} as const;

export type Ramp = keyof typeof RAMPS;

interface Props {
	shape: Shape;
	cell: number;
	ramp?: Ramp;
	gain?: number;
	seed?: number;
	className?: string;
}

const ENTER_MS = 1100;

export function Dither({
	shape,
	cell,
	ramp = "brand",
	gain,
	seed,
	className,
}: Props) {
	const ref = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const canvas = ref.current;
		const ctx = canvas?.getContext("2d");
		if (!canvas || !ctx) return;
		const [a, b, c] = RAMPS[ramp];
		const spec: DitherSpec = {
			shape,
			cell,
			colors: [hex(a), hex(b), hex(c)],
			gain,
			seed,
		};
		const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		let cells = ditherCells(spec, 1, 1);
		let frame = 0;
		let started = 0;

		const draw = (progress: number) => {
			ctx.clearRect(0, 0, canvas.width, canvas.height);
			for (const p of cells) {
				if (p.threshold > progress) continue;
				const inset = (cell - p.size) / 2;
				ctx.fillStyle = `rgb(${p.color[0]} ${p.color[1]} ${p.color[2]})`;
				ctx.fillRect(p.x + inset, p.y + inset, p.size, p.size);
			}
		};

		const resize = () => {
			const { width, height } = canvas.getBoundingClientRect();
			const dpr = Math.min(window.devicePixelRatio || 1, 2);
			canvas.width = Math.round(width * dpr);
			canvas.height = Math.round(height * dpr);
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			cells = ditherCells(spec, width, height);
			if (started) draw(1);
		};

		const tick = (now: number) => {
			const t = Math.min(1, (now - started) / ENTER_MS);
			draw(1 - (1 - t) ** 3);
			if (t < 1) frame = requestAnimationFrame(tick);
		};

		const sizes = new ResizeObserver(resize);
		sizes.observe(canvas);
		const seen = new IntersectionObserver(
			([entry]) => {
				if (!entry?.isIntersecting) return;
				seen.disconnect();
				started = performance.now();
				if (still) draw(1);
				else frame = requestAnimationFrame(tick);
			},
			{ rootMargin: "120px" },
		);
		seen.observe(canvas);
		return () => {
			cancelAnimationFrame(frame);
			sizes.disconnect();
			seen.disconnect();
		};
	}, [shape, cell, ramp, gain, seed]);

	return <canvas ref={ref} aria-hidden className={className} />;
}
