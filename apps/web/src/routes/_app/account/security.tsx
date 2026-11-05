import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { z } from "zod";
import {
	PasskeysSection,
	SessionsSection,
} from "@/components/access/account-devices";
import { TwoFactorSection } from "@/components/access/account-two-factor";
import { TwoFactorRequirement } from "@/components/access/two-factor-requirement";
import { Page, PageHeader } from "@/components/page-header";
import { useSessionUser } from "@/lib/auth";
import { stepParam } from "@/lib/search";

export const Route = createFileRoute("/_app/account/security")({
	validateSearch: z.object({ step: stepParam }),
	staticData: { crumb: "Account and security" },
	component: AccountSecurity,
});

function AccountSecurity() {
	const { step } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const user = useSessionUser();
	const onStepChange = useCallback(
		(next: string, { replace }: { replace: boolean }) =>
			navigate({ search: { step: next }, replace }),
		[navigate],
	);
	return (
		<Page className="max-w-4xl">
			<PageHeader
				title="Account and security"
				description={
					user
						? `How ${user.email} signs in, and where it is signed in right now.`
						: "How you sign in, and where you are signed in right now."
				}
			/>
			<div className="grid gap-8">
				<TwoFactorRequirement />
				<TwoFactorSection
					step={step}
					onStepChange={onStepChange}
					onClose={() => navigate({ search: {}, replace: true })}
				/>
				<PasskeysSection />
				<SessionsSection />
			</div>
		</Page>
	);
}
