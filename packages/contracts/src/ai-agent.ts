import { z } from "zod";

/**
 * The AI page's Agent: conversations a member has with a model that can call every API
 * operation on their behalf. Parts follow the AI SDK's `UIMessage` part shapes, so the web
 * renders them with AI Elements as they are.
 */

export const aiAgentToolStates = [
	"input-available",
	"approval-requested",
	"output-available",
	"output-error",
	"output-denied",
] as const;

export const AiAgentPart = z.discriminatedUnion("type", [
	z.object({ type: z.literal("text"), text: z.string() }),
	z.object({ type: z.literal("reasoning"), text: z.string() }),
	z.object({
		type: z.literal("dynamic-tool"),
		toolCallId: z.string(),
		toolName: z.string(),
		/** The operation's summary, shown instead of its name. */
		title: z.string().optional(),
		state: z.enum(aiAgentToolStates),
		input: z.unknown(),
		output: z.unknown().optional(),
		errorText: z.string().optional(),
		/** Set on operations that delete or stop something: they wait for the member. */
		approval: z
			.object({
				id: z.string(),
				approved: z.boolean().optional(),
				reason: z.string().optional(),
			})
			.optional(),
	}),
]);
export type AiAgentPart = z.infer<typeof AiAgentPart>;

export const AiAgentMessage = z.object({
	id: z.string(),
	role: z.enum(["user", "assistant"]),
	parts: z.array(AiAgentPart),
	/** `provider/model` that answered, for assistant messages. */
	model: z.string().nullable(),
	inputTokens: z.number().int(),
	outputTokens: z.number().int(),
	/** False while the assistant is still writing it. */
	done: z.boolean(),
	createdAt: z.string(),
});
export type AiAgentMessage = z.infer<typeof AiAgentMessage>;

/** `waiting`: paused on an operation the member must approve or deny. */
export const aiAgentStatuses = [
	"idle",
	"running",
	"waiting",
	"failed",
] as const;
export const AiAgentStatus = z.enum(aiAgentStatuses);
export type AiAgentStatus = z.infer<typeof AiAgentStatus>;

export const AiAgentConversation = z.object({
	id: z.string(),
	title: z.string(),
	model: z.string(),
	status: AiAgentStatus,
	error: z.string().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
});
export type AiAgentConversation = z.infer<typeof AiAgentConversation>;

/** /ws channel of one conversation. */
export const aiAgentChannel = (conversationId: string) =>
	`ai-agent:${conversationId}`;
