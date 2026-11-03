import {
	CircleCheckIcon,
	InfoIcon,
	Loader2Icon,
	OctagonXIcon,
	TriangleAlertIcon,
} from "lucide-react";
import type * as React from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useTheme } from "@/lib/theme";

const Toaster = ({ ...props }: ToasterProps) => {
	const { resolved } = useTheme();

	return (
		<Sonner
			theme={resolved}
			className="toaster group"
			icons={{
				success: <CircleCheckIcon className="size-4 text-ok-text" />,
				info: <InfoIcon className="size-4 text-info-text" />,
				warning: <TriangleAlertIcon className="size-4 text-warn-text" />,
				error: <OctagonXIcon className="size-4 text-bad-text" />,
				loading: <Loader2Icon className="size-4 animate-spin" />,
			}}
			style={
				{
					"--normal-bg": "var(--popover)",
					"--normal-text": "var(--popover-foreground)",
					"--normal-border": "var(--border)",
					"--border-radius": "var(--radius-lg)",
				} as React.CSSProperties
			}
			toastOptions={{
				classNames: {
					toast: "cn-toast shadow-float! text-sm!",
					description: "text-muted-foreground!",
				},
			}}
			{...props}
		/>
	);
};

export { Toaster };
