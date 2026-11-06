import sharp from "sharp";

/** Regenerates the responsive screenshot set from the source crops in assets/. */
const jobs = [{ src: "assets/database.png", name: "database" }];
for (const { src, name } of jobs) {
	for (const width of [800, 1600]) {
		const img = sharp(src).resize({ width });
		await img
			.clone()
			.avif({ quality: 60 })
			.toFile(`public/shots/${name}-${width}.avif`);
		await img
			.clone()
			.webp({ quality: 78 })
			.toFile(`public/shots/${name}-${width}.webp`);
	}
}
