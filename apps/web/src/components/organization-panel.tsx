import { ImageUp } from "lucide-react";
import { type DragEvent, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { isOrgAdmin } from "@/components/access/members-dialogs";
import { Field } from "@/components/field";
import { OrgAvatar } from "@/components/org-avatar";
import { Panel, SkeletonRows } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	useMe,
	useOrganization,
	useUpdateOrganization,
} from "@/lib/api/access";
import { toLogoDataUrl } from "@/lib/logo-image";
import { cn } from "@/lib/utils";

/** Name and logo of the active organization; admins edit them, everyone else reads them. */
export function OrganizationPanel() {
	const { data: org, isPending } = useOrganization();
	const { data: me } = useMe();
	const save = useUpdateOrganization();
	const canEdit = isOrgAdmin(me);
	const nameId = useId();
	const fileRef = useRef<HTMLInputElement>(null);
	const [name, setName] = useState("");
	const [logo, setLogo] = useState<string | null>(null);
	const [dragging, setDragging] = useState(false);
	const [reading, setReading] = useState(false);

	// Reset the draft whenever the saved profile changes (first load, save, org switch).
	useEffect(() => {
		if (!org) return;
		setName(org.name);
		setLogo(org.logo);
	}, [org]);

	const trimmed = name.trim();
	const dirty = !!org && (trimmed !== org.name || logo !== org.logo);
	const nameError =
		trimmed.length === 0 ? "The organization needs a name" : undefined;

	async function pick(file: File | undefined) {
		if (!file) return;
		if (!file.type.startsWith("image/") || file.type === "image/svg+xml") {
			toast.error("Use a PNG, JPEG, WebP or GIF image");
			return;
		}
		setReading(true);
		try {
			setLogo(await toLogoDataUrl(file));
		} catch (err) {
			toast.error("Couldn't read that image", {
				description: err instanceof Error ? err.message : undefined,
			});
		} finally {
			setReading(false);
		}
	}

	const onDrop = (e: DragEvent) => {
		e.preventDefault();
		setDragging(false);
		if (canEdit) void pick(e.dataTransfer.files[0]);
	};

	const submit = () => {
		if (!org || nameError) return;
		save.mutate(
			{
				...(trimmed !== org.name && { name: trimmed }),
				...(logo !== org.logo && { logo }),
			},
			{
				onSuccess: () => toast("Organization saved"),
				onError: (err) =>
					toast.error("Couldn't save the organization", {
						description: err.message,
					}),
			},
		);
	};

	return (
		<Panel id="organization" title="Organization">
			{isPending || !org ? (
				<SkeletonRows rows={2} />
			) : (
				<form
					onSubmit={(e) => {
						e.preventDefault();
						submit();
					}}
				>
					<div className="grid gap-6 p-4">
						<div className="flex items-center gap-4">
							<button
								type="button"
								disabled={!canEdit || reading}
								onClick={() => fileRef.current?.click()}
								onDragOver={(e) => {
									e.preventDefault();
									if (canEdit) setDragging(true);
								}}
								onDragLeave={() => setDragging(false)}
								onDrop={onDrop}
								aria-label={logo ? "Replace logo" : "Upload logo"}
								className={cn(
									"group relative size-20 shrink-0 rounded-xl outline-none transition-[scale,box-shadow] duration-(--duration-fast) focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card enabled:active:scale-[0.96] disabled:cursor-default",
									dragging &&
										"ring-2 ring-brand ring-offset-2 ring-offset-card",
								)}
							>
								<OrgAvatar
									name={trimmed || org.name}
									logo={logo}
									className="size-full rounded-xl text-3xl"
								/>
								{canEdit && (
									<span
										aria-hidden
										className={cn(
											"absolute inset-0 grid place-items-center rounded-xl bg-black/45 text-white opacity-0 transition-opacity duration-(--duration-fast) group-hover:opacity-100 group-focus-visible:opacity-100",
											(dragging || reading) && "opacity-100",
										)}
									>
										<ImageUp className="size-5" />
									</span>
								)}
							</button>
							<div className="grid min-w-0 gap-1.5">{logoActions()}</div>
						</div>

						<Field
							id={nameId}
							label="Name"
							error={canEdit ? nameError : undefined}
							hint={
								canEdit
									? "Shown in the sidebar, in invitations and in the browser tab."
									: "Only admins can change the name and logo."
							}
						>
							<Input
								id={nameId}
								value={name}
								maxLength={80}
								readOnly={!canEdit}
								aria-invalid={!!nameError}
								aria-describedby={`${nameId}-msg`}
								onChange={(e) => setName(e.target.value)}
								className="max-w-sm"
							/>
						</Field>
					</div>

					{canEdit && (
						<div className="flex items-center justify-end gap-2 border-t px-4 py-3">
							{dirty && (
								<Button
									type="button"
									variant="ghost"
									onClick={() => {
										setName(org.name);
										setLogo(org.logo);
									}}
								>
									Discard
								</Button>
							)}
							<Button
								type="submit"
								disabled={!dirty || !!nameError || save.isPending}
							>
								{save.isPending ? "Saving…" : "Save"}
							</Button>
						</div>
					)}
					<input
						ref={fileRef}
						type="file"
						accept="image/png,image/jpeg,image/webp,image/gif"
						className="sr-only"
						tabIndex={-1}
						aria-hidden
						onChange={(e) => {
							void pick(e.target.files?.[0]);
							e.target.value = "";
						}}
					/>
				</form>
			)}
		</Panel>
	);

	function logoActions() {
		if (!canEdit)
			return (
				<p className="text-sm text-muted-foreground">
					{logo ? "Organization logo" : "No logo yet"}
				</p>
			);
		return (
			<>
				<p className="text-sm font-medium">Logo</p>
				<div className="flex flex-wrap items-center gap-2">
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={reading}
						onClick={() => fileRef.current?.click()}
					>
						{reading ? "Reading…" : logo ? "Replace" : "Upload"}
					</Button>
					{logo && (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => setLogo(null)}
						>
							Remove
						</Button>
					)}
				</div>
				<p className="text-xs text-muted-foreground">
					Square works best. Cropped to the center and resized to 256 px. Drop
					an image on the tile to replace it.
				</p>
			</>
		);
	}
}
