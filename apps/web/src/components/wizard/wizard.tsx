import { ArrowLeft, ArrowRight, Check, Loader2 } from "lucide-react";
import {
	type CSSProperties,
	type FormEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

export type WizardValues = Record<string, unknown>;

export type TestResult = { ok: boolean; message: string; detail?: string };

/** A test step is a small state machine; Next unlocks only on `passed` for the current answers. */
export type TestState =
	| { phase: "idle" }
	| { phase: "running" }
	| { phase: "passed" | "failed"; result: TestResult; signature: string };

export type WizardStep<V extends WizardValues> = {
	id: string;
	title: string;
	description?: string;
	/** Validates the answers this step owns. A function lets it depend on earlier answers. */
	schema?: z.ZodType | ((values: V) => z.ZodType);
	/** "Test connection" pattern: the step must pass `run` before Next unlocks. */
	test?: (values: V) => Promise<TestResult>;
	/**
	 * The answers the test depends on; a pass stays valid until one of them changes. Without
	 * it every answer counts, so filling in a later step would undo the pass.
	 */
	testKeys?: (keyof V & string)[];
	/**
	 * A gate computed from state the step does not own (work running on the server): `true`
	 * lets Continue through, a string says what is still missing.
	 */
	ready?: (values: V) => true | string;
	/** Hide the step for the current answers (e.g. DNS checks for generated domains). */
	when?: (values: V) => boolean;
	render: (w: WizardApi<V>) => ReactNode;
};

export type WizardApi<V extends WizardValues> = {
	values: V;
	set: <K extends keyof V>(key: K, value: V[K]) => void;
	/** Props for a text-like control bound to `key`. */
	bind: (key: keyof V & string) => {
		id: string;
		name: string;
		value: string;
		onChange: (e: { target: { value: string } }) => void;
		"aria-invalid": boolean | undefined;
		"aria-describedby": string;
	};
	error: (key: keyof V & string) => string | undefined;
	goTo: (stepId: string) => void;
	steps: WizardStep<V>[];
	test: TestState;
	runTest: () => void;
};

const signatureOf = <V extends WizardValues>(values: V, step?: WizardStep<V>) =>
	JSON.stringify(step?.testKeys ? step.testKeys.map((k) => values[k]) : values);

function resolveSchema<V extends WizardValues>(step: WizardStep<V>, values: V) {
	return typeof step.schema === "function" ? step.schema(values) : step.schema;
}

function stepErrors<V extends WizardValues>(step: WizardStep<V>, values: V) {
	const schema = resolveSchema(step, values);
	if (!schema) return {};
	const parsed = schema.safeParse(values);
	if (parsed.success) return {};
	const errors: Record<string, string> = {};
	for (const issue of parsed.error.issues) {
		const key = String(issue.path[0] ?? "_");
		errors[key] ??= issue.message;
	}
	return errors;
}

function loadValues<V extends WizardValues>(id: string, defaults: V): V {
	try {
		const raw = sessionStorage.getItem(`wizard:${id}`);
		return raw ? { ...defaults, ...JSON.parse(raw) } : defaults;
	} catch {
		return defaults;
	}
}

export type WizardProps<V extends WizardValues> = {
	/** Storage key for answers; one per flow. */
	id: string;
	steps: WizardStep<V>[];
	defaultValues: V;
	/** Keys never written to sessionStorage (passwords, tokens). */
	secretKeys?: (keyof V)[];
	/** Current step id from the URL. */
	step: string | undefined;
	onStepChange: (stepId: string, opts: { replace: boolean }) => void;
	onComplete: (values: V) => Promise<void>;
	finishLabel: string;
	className?: string;
};

export function Wizard<V extends WizardValues>({
	id,
	steps: allSteps,
	defaultValues,
	secretKeys = [],
	step: urlStep,
	onStepChange,
	onComplete,
	finishLabel,
	className,
}: WizardProps<V>) {
	const [values, setValues] = useState<V>(() => loadValues(id, defaultValues));
	const [tests, setTests] = useState<Record<string, TestState>>({});
	const [attempted, setAttempted] = useState<Set<string>>(() => new Set());
	const [finishing, setFinishing] = useState(false);
	const formRef = useRef<HTMLFormElement>(null);
	const bodyRef = useRef<HTMLDivElement>(null);

	const steps = useMemo(
		() => allSteps.filter((s) => s.when?.(values) ?? true),
		[allSteps, values],
	);

	const isComplete = useCallback(
		(s: WizardStep<V>) => {
			if (Object.keys(stepErrors(s, values)).length) return false;
			if (s.ready && s.ready(values) !== true) return false;
			if (!s.test) return true;
			const t = tests[s.id];
			return t?.phase === "passed" && t.signature === signatureOf(values, s);
		},
		[values, tests],
	);

	// Deep links can't skip ahead of the first incomplete step.
	const firstIncomplete = steps.findIndex((s) => !isComplete(s));
	const reachable = firstIncomplete === -1 ? steps.length - 1 : firstIncomplete;
	const requested = Math.max(
		0,
		steps.findIndex((s) => s.id === urlStep),
	);
	const index = Math.min(requested, reachable);
	const found = steps[index] ?? steps[0];
	if (!found) throw new Error("Wizard needs at least one step");
	const current: WizardStep<V> = found;

	useEffect(() => {
		if (urlStep !== current.id) onStepChange(current.id, { replace: true });
	}, [urlStep, current.id, onStepChange]);

	useEffect(() => {
		try {
			const persisted = { ...values };
			for (const key of secretKeys) delete persisted[key];
			sessionStorage.setItem(`wizard:${id}`, JSON.stringify(persisted));
		} catch {}
	}, [id, values, secretKeys]);

	// Direction of the last step change; 0 on first paint so nothing animates on load.
	const nav = useRef({ index, dir: 0 });
	if (nav.current.index !== index) {
		nav.current = { index, dir: index > nav.current.index ? 1 : -1 };
	}
	const direction = nav.current.dir;

	const errors = attempted.has(current.id) ? stepErrors(current, values) : {};
	const testState: TestState = (() => {
		const t = tests[current.id];
		if (!t) return { phase: "idle" };
		if (t.phase === "passed" || t.phase === "failed") {
			return t.signature === signatureOf(values, current)
				? t
				: { phase: "idle" };
		}
		return t;
	})();
	const isLast = index === steps.length - 1;

	const runTest = useCallback(() => {
		const test = current.test;
		if (!test) return;
		const sig = signatureOf(values, current);
		setTests((t) => ({ ...t, [current.id]: { phase: "running" } }));
		test(values)
			.catch(
				(e: unknown): TestResult => ({
					ok: false,
					message: "The test couldn't run",
					detail: e instanceof Error ? e.message : String(e),
				}),
			)
			.then((result) =>
				setTests((t) => ({
					...t,
					[current.id]: {
						phase: result.ok ? "passed" : "failed",
						result,
						signature: sig,
					},
				})),
			);
	}, [current, values]);

	const goTo = useCallback(
		(stepId: string) => onStepChange(stepId, { replace: false }),
		[onStepChange],
	);

	const back = useCallback(() => {
		const prev = steps[index - 1];
		if (prev) goTo(prev.id);
	}, [steps, index, goTo]);

	async function next(e?: FormEvent) {
		e?.preventDefault();
		if (finishing) return;
		setAttempted((a) => new Set(a).add(current.id));
		if (!isComplete(current)) {
			const body = bodyRef.current;
			if (body) {
				body.classList.remove("t-shake");
				void body.offsetWidth;
				body.classList.add("t-shake");
			}
			const firstInvalid = formRef.current?.querySelector<HTMLElement>(
				"[aria-invalid=true]",
			);
			firstInvalid?.focus();
			return;
		}
		const following = steps[index + 1];
		if (following) {
			goTo(following.id);
			return;
		}
		setFinishing(true);
		try {
			await onComplete(values);
			sessionStorage.removeItem(`wizard:${id}`);
		} catch (err) {
			toast.error("Couldn't finish", {
				description: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setFinishing(false);
		}
	}

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement | null;
			const editing =
				target?.closest("input, textarea, [contenteditable=true]") !== null;
			if (e.altKey && e.key === "ArrowLeft" && !editing) {
				e.preventDefault();
				back();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [back]);

	const api: WizardApi<V> = {
		values,
		set: (key, value) => setValues((v) => ({ ...v, [key]: value })),
		bind: (key) => ({
			id: `wz-${key}`,
			name: key,
			value: String(values[key] ?? ""),
			onChange: (e) => setValues((v) => ({ ...v, [key]: e.target.value })),
			"aria-invalid": errors[key] ? true : undefined,
			"aria-describedby": `wz-${key}-msg`,
		}),
		error: (key) => errors[key],
		goTo,
		steps,
		test: testState,
		runTest,
	};

	const notReady = current.ready?.(values);
	const blockedBy =
		typeof notReady === "string"
			? notReady
			: current.test && testState.phase !== "passed"
				? "Run the test to continue"
				: undefined;
	const blockedByTest = blockedBy !== undefined;

	return (
		<div
			className={cn(
				"grid gap-x-12 gap-y-6 lg:grid-cols-[13.5rem_minmax(0,1fr)]",
				className,
			)}
		>
			<StepsRail
				steps={steps}
				index={index}
				reachable={reachable}
				isComplete={isComplete}
				onSelect={goTo}
			/>

			<form
				ref={formRef}
				onSubmit={next}
				noValidate
				className="min-w-0"
				aria-labelledby={`wz-step-${current.id}`}
			>
				<div
					key={current.id}
					className={cn(direction !== 0 && "t-page")}
					style={{ "--dir": direction } as CSSProperties}
				>
					<div className="mb-6">
						<h2
							id={`wz-step-${current.id}`}
							className="text-lg font-semibold"
							tabIndex={-1}
						>
							{current.title}
						</h2>
						{current.description && (
							<p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">
								{current.description}
							</p>
						)}
					</div>
					<div ref={bodyRef}>{current.render(api)}</div>
				</div>

				<div className="mt-8 flex items-center justify-between gap-3 border-t pt-5">
					<Button
						type="button"
						variant="ghost"
						onClick={back}
						disabled={index === 0 || finishing}
						className={cn(index === 0 && "invisible")}
					>
						<ArrowLeft data-icon="inline-start" />
						Back
						<Kbd className="ml-1 hidden sm:inline-flex">⌥←</Kbd>
					</Button>
					<div className="flex items-center gap-3">
						{blockedBy && (
							<span className="hidden text-xs text-muted-foreground sm:inline">
								{blockedBy}
							</span>
						)}
						<Button
							type="submit"
							size="lg"
							disabled={finishing || testState.phase === "running"}
							aria-disabled={blockedByTest || undefined}
							className={cn(blockedByTest && "opacity-60")}
						>
							{finishing && <Loader2 className="animate-spin" />}
							{isLast ? finishLabel : "Continue"}
							{!isLast && !finishing && <ArrowRight data-icon="inline-end" />}
							<Kbd className="ml-1 hidden bg-primary-foreground/15 text-primary-foreground/80 sm:inline-flex">
								↵
							</Kbd>
						</Button>
					</div>
				</div>
			</form>
		</div>
	);
}

function StepsRail<V extends WizardValues>({
	steps,
	index,
	reachable,
	isComplete,
	onSelect,
}: {
	steps: WizardStep<V>[];
	index: number;
	reachable: number;
	isComplete: (s: WizardStep<V>) => boolean;
	onSelect: (id: string) => void;
}) {
	const current = steps[index];
	return (
		<nav aria-label="Progress">
			{/* Compact rail below lg: position and a segmented bar. */}
			<div className="lg:hidden">
				<p className="text-xs text-muted-foreground">
					<span className="tabular">
						{index + 1} of {steps.length}
					</span>
					{current && (
						<span className="text-foreground"> · {current.title}</span>
					)}
				</p>
				<div className="mt-2 flex gap-1">
					{steps.map((s, i) => (
						<span
							key={s.id}
							className={cn(
								"h-1 flex-1 rounded-full bg-muted-foreground/15 transition-colors duration-(--duration-fast)",
								i <= index && "bg-foreground",
							)}
						/>
					))}
				</div>
			</div>

			<ol className="hidden flex-col gap-0.5 lg:flex">
				{steps.map((s, i) => {
					const done = i < index && isComplete(s);
					const active = i === index;
					const enabled = i <= reachable && !active;
					return (
						<li key={s.id}>
							<button
								type="button"
								disabled={!enabled}
								aria-current={active ? "step" : undefined}
								onClick={() => onSelect(s.id)}
								className={cn(
									"group flex w-full items-start gap-3 rounded-md px-2 py-2 text-left transition-colors duration-(--duration-quick)",
									enabled && "hover:bg-muted",
									!enabled && !active && "cursor-default",
								)}
							>
								<span
									className={cn(
										"mt-px grid size-5 shrink-0 place-items-center rounded-full text-2xs font-semibold tabular transition-colors duration-(--duration-fast)",
										done && "bg-foreground text-background",
										active && "bg-brand text-brand-foreground",
										!done &&
											!active &&
											"text-muted-foreground ring-1 ring-border ring-inset",
									)}
								>
									{done ? (
										<Check className="size-3" strokeWidth={3} aria-hidden />
									) : (
										i + 1
									)}
								</span>
								<span className="min-w-0">
									<span
										className={cn(
											"block text-sm leading-5",
											active
												? "font-medium text-foreground"
												: done
													? "text-foreground"
													: "text-muted-foreground",
										)}
									>
										{s.title}
									</span>
									{done && <span className="sr-only">, completed</span>}
								</span>
							</button>
						</li>
					);
				})}
			</ol>
		</nav>
	);
}
