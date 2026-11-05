import { z } from "zod";

export const errorCodes = [
	"bad_request",
	"validation_failed",
	"unprocessable",
	"unauthorized",
	"forbidden",
	/** The organization requires a second factor this user has not set up; enrol, then retry. */
	"two_factor_required",
	"not_found",
	"conflict",
	"rate_limited",
	"internal",
] as const;
export const ErrorCode = z.enum(errorCodes);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ApiError = z.object({
	error: z.object({
		code: ErrorCode,
		message: z.string(),
		details: z.unknown().optional(),
	}),
});
export type ApiError = z.infer<typeof ApiError>;
