import { useEffect } from "react";
import { useOrganization } from "@/lib/api/access";

const DEFAULT_TITLE = "LogiStack";
const DEFAULT_ICON = "/favicon.svg";

function setIcon(href: string) {
	const link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
	if (!link) return;
	link.href = href;
	// The SVG mark declares its type; a data URL carries its own.
	if (href === DEFAULT_ICON) link.type = "image/svg+xml";
	else link.removeAttribute("type");
}

/** Tab title and favicon follow the active organization while the app shell is mounted. */
export function useDocumentBranding() {
	const { data: org } = useOrganization();
	const name = org?.name;
	const logo = org?.logo;

	useEffect(() => {
		document.title = name ? `${DEFAULT_TITLE} - ${name}` : DEFAULT_TITLE;
		setIcon(logo ?? DEFAULT_ICON);
	}, [name, logo]);

	// Sign-out and the auth screens go back to LogiStack's own branding.
	useEffect(
		() => () => {
			document.title = DEFAULT_TITLE;
			setIcon(DEFAULT_ICON);
		},
		[],
	);
}
