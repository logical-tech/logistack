import {
	type AiAgentConversation,
	type AiAgentMessage,
	type AiAgentPart,
	type AiAgentStatus,
	aiAgentChannel,
} from "@logistack/contracts";
import {
	queryOptions,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { isMock } from ".";
import { client } from "./client";
import { done, ok } from "./http";
import { subscribe } from "./live";

export type { AiAgentConversation, AiAgentMessage, AiAgentPart, AiAgentStatus };
export type AiAgentToolPart = Extract<AiAgentPart, { type: "dynamic-tool" }>;
export type AiAgentDetail = {
	conversation: AiAgentConversation;
	messages: AiAgentMessage[];
};
/** One frame of a running conversation: its status and the message being written. */
export type AiAgentUpdate = {
	status: AiAgentStatus;
	error: string | null;
	message?: AiAgentMessage;
};

export type AiAgentApi = {
	list(): Promise<AiAgentConversation[]>;
	get(id: string): Promise<AiAgentDetail>;
	start(text: string, model: string): Promise<AiAgentConversation>;
	send(id: string, text: string, model?: string): Promise<AiAgentConversation>;
	answer(
		id: string,
		toolCallId: string,
		approved: boolean,
	): Promise<AiAgentConversation>;
	stop(id: string): Promise<void>;
	rename(id: string, title: string): Promise<AiAgentConversation>;
	remove(id: string): Promise<void>;
	/** Follows a conversation live; returns the unsubscribe. */
	follow(id: string, fn: (u: AiAgentUpdate) => void): () => void;
};

const c = client.api.ai.agent.conversations;

const http: AiAgentApi = {
	list: () => ok(c.$get()),
	get: (id) => ok(c[":id"].$get({ param: { id } })),
	start: (text, model) => ok(c.$post({ json: { text, model } })),
	send: (id, text, model) =>
		ok(c[":id"].messages.$post({ param: { id }, json: { text, model } })),
	answer: (id, toolCallId, approved) =>
		ok(
			c[":id"].approvals.$post({
				param: { id },
				json: { toolCallId, approved },
			}),
		),
	stop: (id) => done(c[":id"].stop.$post({ param: { id } })),
	rename: (id, title) =>
		ok(c[":id"].$patch({ param: { id }, json: { title } })),
	remove: (id) => done(c[":id"].$delete({ param: { id } })),
	follow: (id, fn) =>
		subscribe(aiAgentChannel(id), (data) => {
			if (data.kind === "ai-agent")
				fn({ status: data.status, error: data.error, message: data.message });
		}),
};

export const aiAgentApi: AiAgentApi = isMock
	? (await import("./mock/ai-agent")).mockAiAgent
	: http;

export const aiAgentListQuery = queryOptions({
	queryKey: ["ai", "agent"],
	queryFn: () => aiAgentApi.list(),
});

export const aiAgentQuery = (id: string) =>
	queryOptions({
		queryKey: ["ai", "agent", id],
		queryFn: () => aiAgentApi.get(id),
	});

/** Folds a live frame into the cached conversation. */
export function applyUpdate(d: AiAgentDetail, u: AiAgentUpdate): AiAgentDetail {
	const messages = [...d.messages];
	if (u.message) {
		const i = messages.findIndex((m) => m.id === u.message?.id);
		if (i >= 0) messages[i] = u.message;
		else messages.push(u.message);
	}
	return {
		conversation: { ...d.conversation, status: u.status, error: u.error },
		messages,
	};
}

export function useAiAgentMutations() {
	const qc = useQueryClient();
	const refresh = (id?: string) => {
		void qc.invalidateQueries({ queryKey: ["ai", "agent"], exact: true });
		if (id) void qc.invalidateQueries({ queryKey: ["ai", "agent", id] });
	};
	return {
		start: useMutation({
			mutationFn: (v: { text: string; model: string }) =>
				aiAgentApi.start(v.text, v.model),
			onSuccess: () => refresh(),
		}),
		send: useMutation({
			mutationFn: (v: { id: string; text: string; model?: string }) =>
				aiAgentApi.send(v.id, v.text, v.model),
			onSuccess: (_r, v) => refresh(v.id),
		}),
		answer: useMutation({
			mutationFn: (v: { id: string; toolCallId: string; approved: boolean }) =>
				aiAgentApi.answer(v.id, v.toolCallId, v.approved),
			onSuccess: (_r, v) => refresh(v.id),
		}),
		stop: useMutation({
			mutationFn: (id: string) => aiAgentApi.stop(id),
			onSuccess: (_r, id) => refresh(id),
		}),
		rename: useMutation({
			mutationFn: (v: { id: string; title: string }) =>
				aiAgentApi.rename(v.id, v.title),
			onSuccess: (_r, v) => refresh(v.id),
		}),
		remove: useMutation({
			mutationFn: (id: string) => aiAgentApi.remove(id),
			onSuccess: () => refresh(),
		}),
	};
}
