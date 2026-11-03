import {
	type CellData,
	type ColumnDef,
	type RowData,
	type TableFeatures,
	tableFeatures,
	useTable,
} from "@tanstack/react-table";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

declare module "@tanstack/react-table" {
	interface ColumnMeta<
		in out TFeatures extends TableFeatures,
		in out TData extends RowData,
		TValue extends CellData = CellData,
	> {
		/** Classes for both th and td: responsive hiding, alignment, width. */
		className?: string;
	}
}

export const tableFeaturesBase = tableFeatures({});
export type BaseFeatures = typeof tableFeaturesBase;

export function DataTable<TData extends RowData>({
	columns,
	data,
	getRowId,
	empty,
	label,
}: {
	columns: ColumnDef<BaseFeatures, TData>[];
	data: TData[];
	getRowId: (row: TData) => string;
	empty?: ReactNode;
	label: string;
}) {
	const table = useTable({
		features: tableFeaturesBase,
		columns,
		data,
		getRowId: (row) => getRowId(row),
	});
	const rows = table.getRowModel().rows;

	return (
		<table className="w-full table-fixed text-sm" aria-label={label}>
			<thead>
				{table.getHeaderGroups().map((group) => (
					<tr key={group.id} className="border-b">
						{group.headers.map((h) => (
							<th
								key={h.id}
								scope="col"
								className={cn(
									"h-9 px-4 text-left text-xs font-medium text-muted-foreground first:pl-4",
									h.column.columnDef.meta?.className,
								)}
							>
								{h.isPlaceholder ? null : <table.FlexRender header={h} />}
							</th>
						))}
					</tr>
				))}
			</thead>
			<tbody>
				{rows.map((row) => (
					<tr
						key={row.id}
						className="border-b transition-colors duration-(--duration-quick) last:border-0 hover:bg-muted/50"
					>
						{row.getAllCells().map((cell) => (
							<td
								key={cell.id}
								className={cn(
									"h-12 px-4 align-middle",
									cell.column.columnDef.meta?.className,
								)}
							>
								<table.FlexRender cell={cell} />
							</td>
						))}
					</tr>
				))}
				{rows.length === 0 && empty && (
					<tr>
						<td colSpan={columns.length} className="px-4 py-10 text-center">
							{empty}
						</td>
					</tr>
				)}
			</tbody>
		</table>
	);
}
