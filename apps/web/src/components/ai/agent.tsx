import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
	BotMessageSquare,
	Check,
	ChevronsUpDown,
	Circle,
	CircleDashed,
	CopyIcon,
	ListChecks,
	MessageSquarePlus,
	Trash2,
	TriangleAlert,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	Confirmation,
	ConfirmationAccepted,
	ConfirmationAction,
	ConfirmationActions,
	ConfirmationRejected,
	ConfirmationRequest,
	ConfirmationTitle,
} from "@/components/ai-elements/confirmation";
import {
	Conversation,
	ConversationContent,
	ConversationEmptyState,
	ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
	Message,
	MessageAction,
	MessageActions,
	MessageContent,
	MessageResponse,
} from "@/components/ai-elements/message";
import {
	ModelSelector,
	ModelSelectorContent,
	ModelSelectorEmpty,
	ModelSelectorGroup,
	ModelSelectorInput,
	ModelSelectorItem,
	ModelSelectorList,
	ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";
import {
	PromptInput,
	PromptInputBody,
	PromptInputButton,
	PromptInputFooter,
	PromptInputSubmit,
	PromptInputTextarea,
	PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import {
	Reasoning,
	ReasoningContent,
	ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Suggestion } from "@/components/ai-elements/suggestion";
import {
	Task,
	TaskContent,
	TaskItem,
	TaskTrigger,
} from "@/components/ai-elements/task";
import {
	Tool,
	ToolContent,
	ToolHeader,
	ToolInput,
	ToolOutput,
} from "@/components/ai-elements/tool";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { aiModelsQuery } from "@/lib/api/ai";
import {
	type AiAgentConversation,
	type AiAgentDetail,
	type AiAgentMessage,
	type AiAgentToolPart,
	aiAgentApi,
	aiAgentListQuery,
	aiAgentQuery,
	applyUpdate,
	useAiAgentMutations,
} from "@/lib/api/ai-agent";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const SUGGESTIONS = [
	"What is running right now, and what failed today?",
	"Which services use the most memory?",
	"Deploy the latest commit of every service in production",
	"Add a daily backup to every Postgres database",
];

/** The chat with the Agent: history on the left, the open conversation on the right. */
export function AgentPage({ conversationId }: { conversationId?: string }) {
	const navigate = useNavigate();
	const open = (c?: string) =>
		navigate({ to: "/ai/agent", search: c ? { c } : {} });
	return (
		<div className="grid h-[calc(100dvh-15rem)] min-h-[32rem] grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-xl border bg-card md:grid-cols-[16rem_minmax(0,1fr)] md:grid-rows-1">
			<History selected={conversationId} onOpen={open} />
			<MobileBar selected={conversationId} onOpen={open} />
			<Chat key={conversationId ?? "new"} id={conversationId} onOpen={open} />
		</div>
	);
}

function History({
	selected,
	onOpen,
}: {
	selected?: string;
	onOpen: (id?: string) => void;
}) {
	const { data } = useQuery(aiAgentListQuery);
	const { remove } = useAiAgentMutations();
	const [deleting, setDeleting] = useState<AiAgentConversation | null>(null);
	return (
		<nav
			aria-label="Conversations"
			className="flex min-h-0 flex-col border-r bg-muted/30 max-md:hidden"
		>
			<div className="p-2">
				<Button
					variant="ghost"
					className="w-full justify-start"
					onClick={() => onOpen()}
				>
					<MessageSquarePlus data-icon="inline-start" />
					New chat
				</Button>
			</div>
			<ul className="min-h-0 flex-1 space-y-px overflow-y-auto px-2 pb-2">
				{!data &&
					[0, 1, 2].map((i) => (
						<li
							key={i}
							className="t-skel mx-2 my-2 h-4 rounded bg-muted-foreground/8"
						/>
					))}
				{data?.map((c) => (
					<li key={c.id} className="group relative">
						<button
							type="button"
							onClick={() => onOpen(c.id)}
							aria-current={c.id === selected ? "page" : undefined}
							className={cn(
								"flex w-full flex-col rounded-md px-2.5 py-1.5 pr-8 text-left transition-colors hover:bg-muted aria-[current=page]:bg-muted",
							)}
						>
							<span className="truncate text-sm">{c.title}</span>
							<span className="flex items-center gap-1.5 text-muted-foreground text-xs">
								<StatusMark status={c.status} />
								{relativeTime(c.updatedAt)}
							</span>
						</button>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={`Delete ${c.title}`}
							className="absolute top-1.5 right-1 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
							onClick={() => setDeleting(c)}
						>
							<Trash2 />
						</Button>
					</li>
				))}
				{data?.length === 0 && (
					<li className="px-2.5 py-2 text-muted-foreground text-sm">
						Your conversations show up here.
					</li>
				)}
			</ul>
			<ConfirmDialog
				open={deleting !== null}
				onOpenChange={(o) => !o && setDeleting(null)}
				title="Delete this conversation?"
				description={
					<>
						<strong>{deleting?.title}</strong> and its messages are deleted.
						Changes the Agent already made stay.
					</>
				}
				confirmLabel="Delete"
				pending={remove.isPending}
				onConfirm={() => {
					if (!deleting) return;
					remove.mutate(deleting.id, {
						onSuccess: () => {
							if (deleting.id === selected) onOpen();
							setDeleting(null);
						},
						onError: (e) => toast.error(e.message),
					});
				}}
			/>
		</nav>
	);
}

/** Below `md` the history column is hidden; its conversations live in this menu. */
function MobileBar({
	selected,
	onOpen,
}: {
	selected?: string;
	onOpen: (id?: string) => void;
}) {
	const { data } = useQuery(aiAgentListQuery);
	const title = data?.find((c) => c.id === selected)?.title ?? "New chat";
	return (
		<div className="flex items-center gap-1 border-b p-2 md:hidden">
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button variant="ghost" className="min-w-0 flex-1 justify-between">
						<span className="truncate">{title}</span>
						<ChevronsUpDown className="size-3.5 opacity-60" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="max-h-80 w-72">
					{data?.length === 0 && (
						<DropdownMenuItem disabled>No conversations yet</DropdownMenuItem>
					)}
					{data?.map((c) => (
						<DropdownMenuItem key={c.id} onSelect={() => onOpen(c.id)}>
							<span className="truncate">{c.title}</span>
							<StatusMark status={c.status} />
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
			<Button
				variant="ghost"
				size="icon"
				aria-label="New chat"
				onClick={() => onOpen()}
			>
				<MessageSquarePlus />
			</Button>
		</div>
	);
}

function StatusMark({ status }: { status: AiAgentConversation["status"] }) {
	if (status === "running")
		return (
			<span className="size-1.5 animate-pulse rounded-full bg-primary">
				<span className="sr-only">Working</span>
			</span>
		);
	if (status === "waiting")
		return (
			<span className="size-1.5 rounded-full bg-amber-500">
				<span className="sr-only">Waiting for approval</span>
			</span>
		);
	if (status === "failed")
		return (
			<span className="size-1.5 rounded-full bg-destructive">
				<span className="sr-only">Failed</span>
			</span>
		);
	return null;
}

/** Keeps the cached conversation in step with the server's live frames. */
function useLiveConversation(id: string | undefined) {
	const qc = useQueryClient();
	const query = useQuery({
		...aiAgentQuery(id ?? ""),
		enabled: Boolean(id),
		// Frames missed while the socket reconnects are picked up here.
		refetchInterval: (q) =>
			q.state.data?.conversation.status === "running" ? 5_000 : false,
	});
	useEffect(() => {
		if (!id) return;
		const key = aiAgentQuery(id).queryKey;
		return aiAgentApi.follow(id, (u) => {
			const before = qc.getQueryData<AiAgentDetail>(key);
			qc.setQueryData<AiAgentDetail>(key, (d) => d && applyUpdate(d, u));
			if (before?.conversation.status !== u.status)
				void qc.invalidateQueries({ queryKey: aiAgentListQuery.queryKey });
		});
	}, [id, qc]);
	return query;
}

function Chat({ id, onOpen }: { id?: string; onOpen: (id?: string) => void }) {
	const { data, error } = useLiveConversation(id);
	const { start, send, stop } = useAiAgentMutations();
	const [model, setModel] = useState<string | null>(null);
	const conversation = data?.conversation;
	const current = model ?? conversation?.model ?? "auto";
	const status = conversation?.status;
	const busy = start.isPending || send.isPending;

	const submit = async (text: string) => {
		const t = text.trim();
		if (!t) return;
		try {
			if (!id) {
				const c = await start.mutateAsync({ text: t, model: current });
				onOpen(c.id);
			} else
				await send.mutateAsync({
					id,
					text: t,
					model: model ?? undefined,
				});
		} catch (e) {
			toast.error((e as Error).message);
			throw e;
		}
	};

	const groups = useMemo(() => group(data?.messages ?? []), [data?.messages]);
	const last = data?.messages.at(-1);
	const thinking =
		status === "running" &&
		(!last || last.role === "user" || last.done || last.parts.length === 0);

	return (
		<section aria-label="Chat" className="flex min-h-0 min-w-0 flex-col">
			<Conversation className="min-h-0 flex-1">
				<ConversationContent className="mx-auto w-full max-w-3xl">
					{!id ? (
						<ConversationEmptyState>
							<div className="flex flex-col items-center gap-4">
								<BotMessageSquare className="size-8 text-muted-foreground" />
								<div className="space-y-1 text-center">
									<h3 className="font-medium text-sm">Ask the Agent</h3>
									<p className="max-w-md text-pretty text-muted-foreground text-sm">
										It works through the same API as this dashboard, with your
										permissions. Anything that deletes or stops waits for your
										approval, and it keeps working after you close the page.
									</p>
								</div>
								<div className="flex max-w-xl flex-wrap justify-center gap-2">
									{SUGGESTIONS.map((s) => (
										<Suggestion
											key={s}
											suggestion={s}
											onClick={(s) => void submit(s).catch(() => {})}
										/>
									))}
								</div>
							</div>
						</ConversationEmptyState>
					) : error ? (
						<ConversationEmptyState
							icon={<TriangleAlert className="size-8" />}
							title="Couldn't open this conversation"
							description={error.message}
						/>
					) : (
						groups.map((g) => (
							<Message from={g.role} key={g.messages[0]?.id}>
								<MessageContent
									className={cn(g.role === "assistant" && "w-full max-w-full")}
								>
									{g.messages.map((m) => (
										<Fragment key={m.id}>
											{m.parts.map((p, i) => (
												<PartView
													// biome-ignore lint/suspicious/noArrayIndexKey: parts have no id and never reorder
													key={i}
													part={p}
													message={m}
													conversationId={id}
													streaming={!m.done && i === m.parts.length - 1}
												/>
											))}
										</Fragment>
									))}
								</MessageContent>
								{g.role === "assistant" && g.text && (
									<MessageActions className="-mt-2">
										<MessageAction
											tooltip="Copy"
											label="Copy answer"
											onClick={() => {
												void navigator.clipboard.writeText(g.text);
												toast.success("Copied");
											}}
										>
											<CopyIcon className="size-3.5" />
										</MessageAction>
									</MessageActions>
								)}
							</Message>
						))
					)}
					{thinking && (
						<Shimmer className="text-sm" duration={1.5}>
							Working…
						</Shimmer>
					)}
					{status === "failed" && conversation?.error && (
						<div
							role="alert"
							className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"
						>
							<TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
							<div>
								<p className="font-medium">The Agent stopped</p>
								<p className="text-muted-foreground">{conversation.error}</p>
							</div>
						</div>
					)}
				</ConversationContent>
				<ConversationScrollButton />
			</Conversation>
			<div className="mx-auto w-full max-w-3xl px-4 pb-4">
				<PromptInput
					onSubmit={({ text }) => submit(text)}
					className="rounded-xl bg-background"
				>
					<PromptInputBody>
						<PromptInputTextarea
							placeholder={
								status === "waiting"
									? "Reply instead of approving…"
									: "Ask the Agent to check, deploy or change something…"
							}
						/>
					</PromptInputBody>
					<PromptInputFooter>
						<PromptInputTools>
							<ModelPicker value={current} onChange={setModel} />
							{status === "waiting" && (
								<span className="text-amber-600 text-xs dark:text-amber-400">
									Waiting for your approval
								</span>
							)}
						</PromptInputTools>
						<PromptInputSubmit
							status={
								busy
									? "submitted"
									: status === "running"
										? "streaming"
										: "ready"
							}
							onStop={() => id && stop.mutate(id)}
						/>
					</PromptInputFooter>
				</PromptInput>
				<p className="mt-2 text-center text-muted-foreground text-xs">
					Alpha. The Agent acts with your permissions and spends your AI budget.
				</p>
			</div>
		</section>
	);
}

type Group = {
	role: AiAgentMessage["role"];
	messages: AiAgentMessage[];
	text: string;
};

/** Consecutive assistant steps read as one answer. */
function group(messages: AiAgentMessage[]): Group[] {
	const out: Group[] = [];
	for (const m of messages) {
		const prev = out.at(-1);
		const g =
			prev && prev.role === "assistant" && m.role === "assistant"
				? prev
				: (out[
						out.push({ role: m.role, messages: [], text: "" }) - 1
					] as Group);
		g.messages.push(m);
		for (const p of m.parts)
			if (p.type === "text") g.text += (g.text ? "\n\n" : "") + p.text;
	}
	return out;
}

function PartView({
	part,
	message,
	conversationId,
	streaming,
}: {
	part: AiAgentMessage["parts"][number];
	message: AiAgentMessage;
	conversationId: string;
	streaming: boolean;
}) {
	if (part.type === "text")
		return message.role === "user" ? (
			<p className="whitespace-pre-wrap">{part.text}</p>
		) : (
			<MessageResponse isAnimating={streaming}>{part.text}</MessageResponse>
		);
	if (part.type === "reasoning")
		return (
			<Reasoning className="w-full" isStreaming={streaming}>
				<ReasoningTrigger />
				<ReasoningContent>{part.text}</ReasoningContent>
			</Reasoning>
		);
	if (part.toolName === "update_tasks") return <TaskList part={part} />;
	return <ToolView part={part} conversationId={conversationId} />;
}

type TaskRow = {
	title: string;
	status: "pending" | "in_progress" | "completed";
};

function TaskList({ part }: { part: AiAgentToolPart }) {
	const tasks = ((part.input as { tasks?: TaskRow[] })?.tasks ?? []).filter(
		(t) => typeof t?.title === "string",
	);
	const doneCount = tasks.filter((t) => t.status === "completed").length;
	return (
		<Task className="w-full">
			<TaskTrigger title="Tasks">
				<button
					type="button"
					className="flex w-full items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground"
				>
					<ListChecks className="size-4" />
					<span>Tasks</span>
					<span className="text-xs tabular-nums">
						{doneCount} of {tasks.length} done
					</span>
				</button>
			</TaskTrigger>
			<TaskContent>
				{tasks.map((t) => (
					<TaskItem
						key={t.title}
						className={cn(
							"flex items-center gap-2",
							t.status === "completed" && "text-muted-foreground line-through",
							t.status === "in_progress" && "text-foreground",
						)}
					>
						{t.status === "completed" ? (
							<Check className="size-3.5 text-emerald-600" />
						) : t.status === "in_progress" ? (
							<CircleDashed className="size-3.5 animate-spin [animation-duration:3s]" />
						) : (
							<Circle className="size-3.5" />
						)}
						{t.title}
					</TaskItem>
				))}
			</TaskContent>
		</Task>
	);
}

function ToolView({
	part,
	conversationId,
}: {
	part: AiAgentToolPart;
	conversationId: string;
}) {
	const { answer } = useAiAgentMutations();
	const input = (part.input ?? {}) as {
		name?: string;
		arguments?: unknown;
		query?: string;
	};
	const answered = part.approval?.approved !== undefined;
	const respond = (approved: boolean) =>
		answer.mutate(
			{ id: conversationId, toolCallId: part.toolCallId, approved },
			{ onError: (e) => toast.error(e.message) },
		);
	return (
		<div className="w-full space-y-2">
			<Tool className="mb-0" defaultOpen={part.state === "approval-requested"}>
				<ToolHeader
					type="dynamic-tool"
					toolName={part.toolName}
					title={part.title ?? input.name ?? part.toolName}
					state={part.state}
				/>
				<ToolContent>
					<ToolInput
						input={
							part.toolName === "call_operation"
								? { operation: input.name, ...(input.arguments as object) }
								: part.input
						}
					/>
					<ToolOutput
						output={part.output as never}
						errorText={part.errorText}
					/>
				</ToolContent>
			</Tool>
			{part.approval && (
				<Confirmation
					approval={
						part.approval as Parameters<typeof Confirmation>[0]["approval"]
					}
					state={part.state}
				>
					<ConfirmationTitle>
						<ConfirmationRequest>
							The Agent wants to run <strong>{part.title ?? input.name}</strong>
							. It deletes or stops something.
						</ConfirmationRequest>
						<ConfirmationAccepted>
							<span className="inline-flex items-center gap-1.5">
								<Check className="size-4 text-emerald-600" />
								You approved {part.title ?? input.name}.
							</span>
						</ConfirmationAccepted>
						<ConfirmationRejected>
							Not run{part.approval.reason ? `: ${part.approval.reason}` : "."}
						</ConfirmationRejected>
					</ConfirmationTitle>
					<ConfirmationActions>
						<ConfirmationAction
							variant="outline"
							disabled={answered || answer.isPending}
							onClick={() => respond(false)}
						>
							Deny
						</ConfirmationAction>
						<ConfirmationAction
							variant="destructive"
							disabled={answered || answer.isPending}
							onClick={() => respond(true)}
						>
							Approve
						</ConfirmationAction>
					</ConfirmationActions>
				</Confirmation>
			)}
		</div>
	);
}

/** The gateway's models; `auto` is the free chain. */
function ModelPicker({
	value,
	onChange,
}: {
	value: string;
	onChange: (model: string) => void;
}) {
	const { data } = useQuery(aiModelsQuery);
	const [open, setOpen] = useState(false);
	const groups = useMemo(() => {
		const by = new Map<string, string[]>();
		for (const m of data ?? []) {
			const list = by.get(m.provider) ?? [];
			list.push(m.id);
			by.set(m.provider, list);
		}
		return [...by];
	}, [data]);
	return (
		<ModelSelector open={open} onOpenChange={setOpen}>
			<ModelSelectorTrigger asChild>
				<PromptInputButton aria-label="Model">
					<span className="max-w-48 truncate">
						{value === "auto" ? "Auto (free first)" : value}
					</span>
					<ChevronsUpDown className="size-3.5 opacity-60" />
				</PromptInputButton>
			</ModelSelectorTrigger>
			<ModelSelectorContent title="Choose a model">
				<ModelSelectorInput placeholder="Search models…" />
				<ModelSelectorList>
					<ModelSelectorEmpty>No model matches.</ModelSelectorEmpty>
					<ModelSelectorGroup heading="Gateway">
						<ModelSelectorItem
							value="auto"
							onSelect={() => {
								onChange("auto");
								setOpen(false);
							}}
						>
							Auto (free providers first)
							{value === "auto" && <Check className="ml-auto size-4" />}
						</ModelSelectorItem>
					</ModelSelectorGroup>
					{groups.map(([provider, ids]) => (
						<ModelSelectorGroup key={provider} heading={provider}>
							{ids.map((m) => (
								<ModelSelectorItem
									key={m}
									value={m}
									onSelect={() => {
										onChange(m);
										setOpen(false);
									}}
								>
									<span className="truncate">
										{m.slice(provider.length + 1)}
									</span>
									{value === m && <Check className="ml-auto size-4" />}
								</ModelSelectorItem>
							))}
						</ModelSelectorGroup>
					))}
				</ModelSelectorList>
			</ModelSelectorContent>
		</ModelSelector>
	);
}
