import { KeySquare, Loader2, Upload } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { CopyLine } from "@/components/access/mcp-section";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ChoiceGroup } from "@/components/wizard/parts";
import { useCreateSshKey } from "@/lib/api/access";
import type { SshKey } from "@/lib/api/access-types";

type Mode = "generate" | "import";

/** Generate an ed25519 key on the server or import a private key, then show the public half to paste elsewhere. */
export function AddSshKeyDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [mode, setMode] = useState<Mode>("generate");
	const [name, setName] = useState("");
	const [privateKey, setPrivateKey] = useState("");
	const [errors, setErrors] = useState<{ name?: string; privateKey?: string }>(
		{},
	);
	const [added, setAdded] = useState<SshKey | null>(null);
	const create = useCreateSshKey();

	function close(next: boolean) {
		onOpenChange(next);
		if (!next) {
			// The private key must not outlive the dialog.
			setPrivateKey("");
			setName("");
			setErrors({});
			setAdded(null);
			setMode("generate");
		}
	}

	function submit(e: FormEvent) {
		e.preventDefault();
		const next: typeof errors = {};
		if (!name.trim()) next.name = "Name the key.";
		if (mode === "import" && !privateKey.trim())
			next.privateKey = "Paste the private key.";
		setErrors(next);
		if (next.name || next.privateKey) return;
		create.mutate(
			{
				name: name.trim(),
				...(mode === "import" && { privateKey: privateKey.trim() }),
			},
			{
				onSuccess: (k) => {
					setPrivateKey("");
					setAdded(k);
					toast.success(`${k.name} added`);
				},
				onError: (err) =>
					mode === "import"
						? setErrors({ privateKey: err.message })
						: setErrors({ name: err.message }),
			},
		);
	}

	return (
		<Dialog open={open} onOpenChange={close}>
			<DialogContent className="sm:max-w-lg">
				{added ? (
					<div className="grid gap-5">
						<DialogHeader>
							<DialogTitle>{added.name} is ready</DialogTitle>
							<DialogDescription>
								Add the public key where it should be trusted: a GitHub or
								GitLab deploy key, or a server's authorized_keys.
							</DialogDescription>
						</DialogHeader>
						<div className="grid gap-1.5">
							<span className="text-sm font-medium">Public key</span>
							<CopyLine value={added.publicKey} label="public key" wrap />
							<span className="font-mono text-xs text-muted-foreground">
								{added.fingerprint}
							</span>
						</div>
						<DialogFooter>
							<Button onClick={() => close(false)}>Done</Button>
						</DialogFooter>
					</div>
				) : (
					<form onSubmit={submit} noValidate className="grid gap-5">
						<DialogHeader>
							<DialogTitle>Add SSH key</DialogTitle>
							<DialogDescription>
								For private Git repositories and for bootstrapping servers. The
								private key is encrypted at rest and never shown again.
							</DialogDescription>
						</DialogHeader>
						<ChoiceGroup
							label="How to add the key"
							value={mode}
							onChange={setMode}
							choices={[
								{
									value: "generate",
									title: "Generate",
									description: "A new ed25519 key, made on the server.",
									icon: KeySquare,
								},
								{
									value: "import",
									title: "Import",
									description: "An OpenSSH private key you already have.",
									icon: Upload,
								},
							]}
						/>
						<Field
							id="ssh-name"
							label="Name"
							error={errors.name}
							hint="What it opens, like Git deploy key."
						>
							<Input
								id="ssh-name"
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="Git deploy key"
								autoComplete="off"
								aria-invalid={errors.name ? true : undefined}
								aria-describedby="ssh-name-msg"
							/>
						</Field>
						{mode === "import" && (
							<Field
								id="ssh-private"
								label="Private key"
								error={errors.privateKey}
								hint="Without a passphrase. Remove one with ssh-keygen -p -N '' -f <file>."
							>
								<Textarea
									id="ssh-private"
									value={privateKey}
									onChange={(e) => setPrivateKey(e.target.value)}
									placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
									autoComplete="off"
									autoCorrect="off"
									autoCapitalize="off"
									spellCheck={false}
									rows={6}
									className="font-mono text-xs"
									aria-invalid={errors.privateKey ? true : undefined}
									aria-describedby="ssh-private-msg"
								/>
							</Field>
						)}
						<DialogFooter>
							<Button
								type="button"
								variant="ghost"
								onClick={() => close(false)}
							>
								Cancel
							</Button>
							<Button type="submit" disabled={create.isPending}>
								{create.isPending && <Loader2 className="animate-spin" />}
								{mode === "generate" ? "Generate key" : "Import key"}
							</Button>
						</DialogFooter>
					</form>
				)}
			</DialogContent>
		</Dialog>
	);
}
