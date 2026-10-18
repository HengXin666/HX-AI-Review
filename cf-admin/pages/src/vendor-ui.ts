// Type facade for tsc. Vite aliases @hx/ui to the real package entry, so this file is not what the browser runs.
import type {
    ButtonHTMLAttributes,
    HTMLAttributes,
    InputHTMLAttributes,
    ReactNode,
    TextareaHTMLAttributes,
} from "react";

type Extra = { variant?: string; size?: string; ripple?: boolean; interactive?: boolean };

export function Button(_props: ButtonHTMLAttributes<HTMLButtonElement> & Extra): ReactNode {
    return null;
}

export function Input(_props: InputHTMLAttributes<HTMLInputElement>): ReactNode {
    return null;
}

export function Textarea(_props: TextareaHTMLAttributes<HTMLTextAreaElement>): ReactNode {
    return null;
}

export function Card(_props: HTMLAttributes<HTMLDivElement> & Extra): ReactNode {
    return null;
}

export function CardHeader(_props: HTMLAttributes<HTMLDivElement>): ReactNode {
    return null;
}

export function CardTitle(_props: HTMLAttributes<HTMLDivElement>): ReactNode {
    return null;
}

export function CardContent(_props: HTMLAttributes<HTMLDivElement>): ReactNode {
    return null;
}

export function Badge(_props: HTMLAttributes<HTMLSpanElement> & { variant?: string }): ReactNode {
    return null;
}

export function PageHeader(_props: {
    title: ReactNode;
    desc?: ReactNode;
    right?: ReactNode;
    className?: string;
}): ReactNode {
    return null;
}

export type DataTableColumn<T> = {
    key: string;
    header: ReactNode;
    render?: (row: T, index: number) => ReactNode;
    width?: string;
};

export function DataTable<T>(_props: {
    columns: readonly DataTableColumn<T>[];
    rows: readonly T[];
    rowKey?: (row: T, index: number) => string | number;
    emptyText?: string;
    bare?: boolean;
    title?: ReactNode;
}): ReactNode {
    return null;
}
