/*
 * The Work rich-text editor (section 11): Tiptap with StarterKit (h2–h3, lists, code, quotes,
 * links), task lists, images from our attachments only, @mentions, #task references as live
 * chips, typography and a placeholder. Pasting or dropping an image uploads it, shows it at once
 * from a blob URL and swaps in the attachment URL when the upload lands. Read-only rendering is
 * the same editor with `editable: false`.
 */
import type { PmDoc, WorkAttachment, WorkPerson } from "@logistack/contracts";
import Image from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import Mention from "@tiptap/extension-mention";
import Typography from "@tiptap/extension-typography";
import { Placeholder } from "@tiptap/extensions";
import {
	type Editor,
	EditorContent,
	NodeViewWrapper,
	type ReactNodeViewProps,
	ReactNodeViewRenderer,
	ReactRenderer,
	useEditor,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { SuggestionOptions, SuggestionProps } from "@tiptap/suggestion";
import {
	forwardRef,
	type ReactNode,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useWorkStatuses, useWorkTask } from "@/lib/api/work-queries";
import { cn } from "@/lib/utils";
import { PersonAvatar, StatusIcon } from "../parts";

/** `/api/work/attachments/<id>` → a URL the browser can load (the mock serves blob/data URLs). */
const ATTACHMENT = /^\/api\/work\/attachments\/([A-Za-z0-9_-]+)(\?thumb=1)?$/;
export const resolveSrc = (src: string) => {
	const m = ATTACHMENT.exec(src);
	return m?.[1] ? api.work.attachments.url(m[1], !!m[2]) : src;
};

const WorkImage = Image.extend({
	renderHTML({ HTMLAttributes }) {
		return [
			"img",
			{
				...HTMLAttributes,
				src: resolveSrc(String(HTMLAttributes.src ?? "")),
				loading: "lazy",
			},
		];
	},
}).configure({ inline: false, allowBase64: false });

// --- suggestion popup ------------------------------------------------------

type Item = {
	id: string;
	label: string;
	hint?: string;
	icon?: ReactNode;
	attrs: Record<string, unknown>;
};
type ListHandle = { onKeyDown: (e: KeyboardEvent) => boolean };
type ListProps = {
	items: Item[];
	command: (attrs: Record<string, unknown>) => void;
	empty: string;
};

const SuggestionList = forwardRef<ListHandle, ListProps>(
	function SuggestionList({ items, command, empty }, ref) {
		const [index, setIndex] = useState(0);
		// A new result list starts at its first item.
		// biome-ignore lint/correctness/useExhaustiveDependencies: `items` is the trigger, not a read.
		useEffect(() => setIndex(0), [items]);
		const pick = (i: number) => {
			const it = items[i];
			if (it) command(it.attrs);
		};
		useImperativeHandle(ref, () => ({
			onKeyDown: (e) => {
				if (e.key === "ArrowDown") {
					setIndex((i) => (i + 1) % Math.max(1, items.length));
					return true;
				}
				if (e.key === "ArrowUp") {
					setIndex((i) => (i - 1 + items.length) % Math.max(1, items.length));
					return true;
				}
				if (e.key === "Enter" || e.key === "Tab") {
					pick(index);
					return items.length > 0;
				}
				return false;
			},
		}));
		return (
			<div
				role="listbox"
				className="w-64 overflow-hidden rounded-lg bg-popover p-1 text-sm text-popover-foreground shadow-float ring-1 ring-foreground/10"
			>
				{items.length === 0 ? (
					<p className="px-2 py-1.5 text-muted-foreground">{empty}</p>
				) : (
					items.map((it, i) => (
						<button
							key={it.id}
							type="button"
							role="option"
							aria-selected={i === index}
							onMouseDown={(e) => {
								e.preventDefault();
								pick(i);
							}}
							className={cn(
								"flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left",
								i === index && "bg-muted",
							)}
						>
							{it.icon}
							<span className="truncate">{it.label}</span>
							{it.hint && (
								<span className="ml-auto shrink-0 text-xs text-muted-foreground">
									{it.hint}
								</span>
							)}
						</button>
					))
				)}
			</div>
		);
	},
);

function popupRender(empty: string): SuggestionOptions<Item>["render"] {
	return () => {
		let r: ReactRenderer<ListHandle, ListProps> | null = null;
		const place = (rect: DOMRect | null | undefined) => {
			const el = r?.element as HTMLElement | undefined;
			if (!el || !rect) return;
			el.style.position = "fixed";
			el.style.zIndex = "60";
			el.style.left = `${Math.min(rect.left, window.innerWidth - 272)}px`;
			el.style.top = `${rect.bottom + 6}px`;
		};
		return {
			onStart: (props: SuggestionProps<Item>) => {
				r = new ReactRenderer(SuggestionList, {
					props: { items: props.items, command: props.command, empty },
					editor: props.editor,
				});
				// Inside a modal sheet the popup must live in the dialog, or it can't take clicks.
				(
					props.editor.view.dom.closest('[role="dialog"]') ?? document.body
				).appendChild(r.element);
				place(props.clientRect?.());
			},
			onUpdate: (props: SuggestionProps<Item>) => {
				r?.updateProps({ items: props.items, command: props.command, empty });
				place(props.clientRect?.());
			},
			onKeyDown: ({ event }) => {
				if (event.key === "Escape") {
					r?.element.remove();
					return true;
				}
				return r?.ref?.onKeyDown(event) ?? false;
			},
			onExit: () => {
				r?.element.remove();
				r?.destroy();
				r = null;
			},
		};
	};
}

// --- task references -------------------------------------------------------

function TaskRefChip({ node }: ReactNodeViewProps) {
	const id = String(node.attrs.id ?? "");
	const { data: task } = useWorkTask(id || undefined);
	const { data: statuses = [] } = useWorkStatuses(task?.projectId ?? "");
	const status = statuses.find((s) => s.id === task?.statusId);
	return (
		<NodeViewWrapper
			as="span"
			className="mx-px inline-flex max-w-72 items-center gap-1 rounded-md bg-muted px-1.5 align-baseline text-[0.92em] leading-6"
			data-task-ref={id}
			title={task?.title}
		>
			{status && <StatusIcon status={status} className="size-3" />}
			<span className="font-medium text-muted-foreground tabular">
				{String(node.attrs.key ?? "")}
			</span>
			{task && <span className="truncate">{task.title}</span>}
		</NodeViewWrapper>
	);
}

const TaskRef = Mention.extend({
	name: "taskRef",
	addAttributes() {
		return {
			id: { default: null },
			key: { default: null },
			number: { default: null },
		};
	},
	renderText({ node }) {
		return String(node.attrs.key ?? "");
	},
	addNodeView() {
		return ReactNodeViewRenderer(TaskRefChip, { as: "span" });
	},
});

// --- the editor ------------------------------------------------------------

export type RichEditorProps = {
	value: PmDoc | null;
	onChange?: (doc: PmDoc, text: string) => void;
	editable?: boolean;
	placeholder?: string;
	people?: WorkPerson[];
	/** Scopes the #task search. */
	projectId?: string;
	/** Uploads a pasted or dropped image; resolves to its attachment. */
	onUpload?: (file: File) => Promise<WorkAttachment>;
	/** ⌘Enter. */
	onSubmit?: () => void;
	autofocus?: boolean;
	className?: string;
	label?: string;
	/** Exposes the editor (clear after send, focus). */
	editorRef?: (editor: Editor | null) => void;
};

const isEmptyDoc = (d: PmDoc | null) =>
	!d?.content?.length ||
	(d.content.length === 1 &&
		d.content[0]?.type === "paragraph" &&
		!d.content[0].content?.length);

export function RichEditor({
	value,
	onChange,
	editable = true,
	placeholder = "Write something, or type @ to mention and # to link a task",
	people = [],
	projectId,
	onUpload,
	onSubmit,
	autofocus,
	className,
	label = "Description",
	editorRef,
}: RichEditorProps) {
	// Suggestion callbacks read the latest props without rebuilding the editor.
	const live = useRef({ people, projectId, onUpload, onSubmit, onChange });
	/** The editor, for paste and drop handlers defined before it exists. */
	const instance = useRef<Editor | null>(null);
	live.current = { people, projectId, onUpload, onSubmit, onChange };

	const uploadImages = (editor: Editor, files: File[], pos?: number) => {
		const upload = live.current.onUpload;
		if (!upload) return false;
		const images = files.filter((f) => f.type.startsWith("image/"));
		if (!images.length) return false;
		for (const file of images) {
			const temp = URL.createObjectURL(file);
			const chain = editor.chain().focus();
			(pos !== undefined
				? chain.insertContentAt(pos, {
						type: "image",
						attrs: { src: temp, alt: file.name },
					})
				: chain.setImage({ src: temp, alt: file.name })
			).run();
			const swap = (src: string | null) => {
				const tr = editor.state.tr;
				editor.state.doc.descendants((n, p) => {
					if (n.type.name === "image" && n.attrs.src === temp) {
						if (src) tr.setNodeMarkup(p, undefined, { ...n.attrs, src });
						else tr.delete(p, p + n.nodeSize);
					}
				});
				editor.view.dispatch(tr);
			};
			upload(file)
				.then((a) => swap(`/api/work/attachments/${a.id}`))
				.catch((e) => {
					swap(null);
					toast.error(`${file.name} wasn't uploaded`, {
						description: e instanceof Error ? e.message : undefined,
					});
				});
		}
		return true;
	};

	const editor = useEditor(
		{
			editable,
			autofocus: autofocus ? "end" : false,
			content: value ?? undefined,
			immediatelyRender: true,
			shouldRerenderOnTransaction: false,
			extensions: [
				StarterKit.configure({
					heading: { levels: [2, 3] },
					underline: false,
					link: {
						openOnClick: !editable,
						autolink: true,
						protocols: ["http", "https", "mailto"],
						HTMLAttributes: {
							rel: "noopener noreferrer nofollow",
							target: "_blank",
						},
					},
				}),
				TaskList,
				TaskItem.configure({ nested: true }),
				WorkImage,
				Typography,
				Placeholder.configure({ placeholder }),
				Mention.configure({
					HTMLAttributes: { class: "work-mention" },
					renderText: ({ node }) => `@${node.attrs.label ?? ""}`,
					renderHTML: ({ node }) => [
						"span",
						{ class: "work-mention", "data-id": node.attrs.id },
						`@${node.attrs.label ?? ""}`,
					],
					suggestion: {
						char: "@",
						items: ({ query }) =>
							live.current.people
								.filter((p) =>
									p.name.toLowerCase().includes(query.toLowerCase()),
								)
								.slice(0, 8)
								.map((p) => ({
									id: p.userId,
									label: p.name,
									hint: p.guest ? "Guest" : undefined,
									icon: <PersonAvatar person={p} />,
									attrs: { id: p.userId, label: p.name },
								})),
						render: popupRender("No one by that name on this project."),
					},
				}),
				TaskRef.configure({
					HTMLAttributes: { class: "work-task-ref" },
					suggestion: {
						char: "#",
						allowSpaces: false,
						items: async ({ query }) => {
							if (!query) return [];
							const r = await api.work
								.search(query, live.current.projectId)
								.catch(() => null);
							return (r?.items ?? []).slice(0, 8).map((t) => ({
								id: t.id,
								label: t.title,
								hint: t.key,
								attrs: {
									id: t.id,
									key: t.key,
									number: Number(t.key.split("-").pop()),
								},
							}));
						},
						render: popupRender("Type a task's key or title."),
					},
				}),
			],
			editorProps: {
				attributes: {
					class: cn("work-prose outline-none", editable && "min-h-24"),
					"aria-label": label,
					role: "textbox",
					"aria-multiline": "true",
				},
				handlePaste: (_view, event): boolean => {
					const files = [...(event.clipboardData?.files ?? [])];
					return files.length
						? uploadImages(instance.current as Editor, files)
						: false;
				},
				handleDrop: (view, event): boolean => {
					const files = [...((event as DragEvent).dataTransfer?.files ?? [])];
					if (!files.length) return false;
					const pos = view.posAtCoords({
						left: (event as DragEvent).clientX,
						top: (event as DragEvent).clientY,
					})?.pos;
					event.preventDefault();
					return uploadImages(instance.current as Editor, files, pos);
				},
				handleKeyDown: (_view, event) => {
					if (
						event.key === "Enter" &&
						(event.metaKey || event.ctrlKey) &&
						live.current.onSubmit
					) {
						live.current.onSubmit();
						return true;
					}
					return false;
				},
			},
			onUpdate: ({ editor }) =>
				live.current.onChange?.(editor.getJSON() as PmDoc, editor.getText()),
		},
		[editable],
	);
	instance.current = editor;

	useEffect(() => {
		editorRef?.(editor);
		return () => editorRef?.(null);
	}, [editor, editorRef]);

	// Replace the content when a different value arrives from outside (reload after a conflict).
	const lastValue = useRef(value);
	useEffect(() => {
		if (!editor || value === lastValue.current) return;
		lastValue.current = value;
		const current = editor.getJSON();
		if (JSON.stringify(current) !== JSON.stringify(value) && !editor.isFocused)
			editor.commands.setContent(value ?? "", { emitUpdate: false });
	}, [editor, value]);

	if (!editable && isEmptyDoc(value)) return null;
	return <EditorContent editor={editor} className={className} />;
}

/** Read-only rendering of a stored doc (comments, previews). */
export function RichText({
	value,
	className,
}: {
	value: PmDoc | null;
	className?: string;
}) {
	return <RichEditor value={value} editable={false} className={className} />;
}
