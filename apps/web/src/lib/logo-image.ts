import { ORG_LOGO_MAX_BYTES } from "@logistack/contracts";

const SIZE = 256;

const bytesOf = (dataUrl: string) =>
	Math.floor(((dataUrl.split(",")[1] ?? "").length * 3) / 4);

/**
 * Center-crops any image the browser can decode to a 256×256 square and encodes it
 * under the server's size cap: WebP first, PNG where WebP encoding is missing (it
 * keeps transparency), JPEG as the last resort for busy photos.
 */
export async function toLogoDataUrl(file: Blob): Promise<string> {
	const bitmap = await createImageBitmap(file);
	const side = Math.min(bitmap.width, bitmap.height);
	const canvas = document.createElement("canvas");
	canvas.width = SIZE;
	canvas.height = SIZE;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("This browser can't resize images");
	ctx.imageSmoothingQuality = "high";
	ctx.drawImage(
		bitmap,
		(bitmap.width - side) / 2,
		(bitmap.height - side) / 2,
		side,
		side,
		0,
		0,
		SIZE,
		SIZE,
	);
	bitmap.close();
	const candidates = [
		canvas.toDataURL("image/webp", 0.9),
		canvas.toDataURL("image/png"),
		canvas.toDataURL("image/jpeg", 0.85),
		canvas.toDataURL("image/jpeg", 0.7),
	];
	const fit = candidates.find(
		(url) =>
			/^data:image\/(webp|png|jpeg);/.test(url) &&
			bytesOf(url) <= ORG_LOGO_MAX_BYTES,
	);
	if (!fit) throw new Error("The image is too detailed to fit in 128 KB");
	return fit;
}
