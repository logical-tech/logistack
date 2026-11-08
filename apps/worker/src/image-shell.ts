import { authForImage, DockerError, managedLabels } from "@logistack/docker";
import type { Ctx } from "./ctx.ts";
import { type ServiceContext, svcName } from "./load.ts";

const notFound = (e: unknown) => e instanceof DockerError && e.notFound;

/**
 * Whether `image` has `/bin/sh`, which the tcp and http healthchecks run in. Reads the image's
 * filesystem through a created, never started container. Null when it cannot tell (pull failed,
 * the image is not for this node's platform); the compiler then keeps its default check.
 */
export async function probeImageShell(
	ctx: Ctx,
	sc: ServiceContext,
	image: string,
	signal?: AbortSignal,
): Promise<boolean | null> {
	const docker = ctx.docker;
	const name = `${svcName(ctx, sc.service.id)}-shell-probe`;
	try {
		await docker.images.inspect(image).catch(async (e) => {
			if (!notFound(e)) throw e;
			await docker.images.pull(image, {
				registryAuth: authForImage(image, sc.registry?.auth),
				signal,
			});
		});
		// A leftover from a crashed probe holds the name.
		await docker.containers.remove(name, true).catch((e) => {
			if (!notFound(e)) throw e;
		});
		const { Id } = await docker.containers.create(name, {
			Image: image,
			Labels: managedLabels({
				resource: sc.service.id,
				kind: "probe",
				org: sc.organizationId,
			}),
		});
		try {
			await docker.containers.statPath(Id, "/bin/sh");
			return true;
		} catch (e) {
			if (notFound(e)) return false;
			throw e;
		} finally {
			await docker.containers.remove(Id, true);
		}
	} catch {
		return null;
	}
}
