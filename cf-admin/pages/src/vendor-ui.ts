// Type facade for tsc. Vite aliases @hx/ui to the real package entry, so this file is not what the browser runs.
import type {
    ButtonHTMLAttributes,
    HTMLAttributes,
    InputHTMLAttributes,
    ReactNode,
    TextareaHTMLAttributes,
} from "react";

type Extra = { variant?: string; size?: string; ripple?: boolean; interactive?: boolean; asChild?: boolean };

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

export function CardDescription(_props: HTMLAttributes<HTMLDivElement>): ReactNode {
    return null;
}

export function CardContent(_props: HTMLAttributes<HTMLDivElement>): ReactNode {
    return null;
}

export function Badge(_props: HTMLAttributes<HTMLSpanElement> & { variant?: string }): ReactNode {
    return null;
}

export function Alert(_props: HTMLAttributes<HTMLDivElement> & { variant?: string }): ReactNode {
    return null;
}

export function AlertTitle(_props: HTMLAttributes<HTMLDivElement>): ReactNode {
    return null;
}

export function AlertDescription(_props: HTMLAttributes<HTMLDivElement>): ReactNode {
    return null;
}

export function Switch(
    _props: HTMLAttributes<HTMLButtonElement> & {
        checked?: boolean;
        onCheckedChange?: (checked: boolean) => void;
        size?: "sm" | "default";
        disabled?: boolean;
        "aria-label"?: string;
    },
): ReactNode {
    return null;
}

export function Separator(_props: HTMLAttributes<HTMLDivElement> & { orientation?: string }): ReactNode {
    return null;
}

export function Skeleton(_props: HTMLAttributes<HTMLDivElement>): ReactNode {
    return null;
}

export function PageHeader(_props: {
    title: ReactNode;
    desc?: ReactNode;
    right?: ReactNode;
    extra?: ReactNode;
    className?: string;
    compact?: boolean;
}): ReactNode {
    return null;
}

export function AppFrame(
    _props: HTMLAttributes<HTMLDivElement> & {
        children: ReactNode;
        contentClassName?: string;
        decoration?: ReactNode;
        overlay?: ReactNode;
    },
): ReactNode {
    return null;
}

export function StatCard(
    _props: HTMLAttributes<HTMLDivElement> & {
        label: ReactNode;
        value: ReactNode;
        hint?: ReactNode;
        icon?: string;
        tone?: "default" | "good" | "bad" | "muted" | "accent";
        extra?: ReactNode;
    },
): ReactNode {
    return null;
}

export function StatGrid(_props: { columns?: 2 | 3 | 4 | 5; className?: string; children: ReactNode }): ReactNode {
    return null;
}

export function EmptyState(_props: {
    text?: ReactNode;
    hint?: ReactNode;
    kind?: "empty" | "error" | "loading" | "denied";
    icon?: string;
    action?: ReactNode;
    className?: string;
    compact?: boolean;
}): ReactNode {
    return null;
}

export function DataBoundary(_props: {
    loading?: boolean;
    error?: unknown;
    empty?: boolean;
    emptyText?: ReactNode;
    loadingText?: ReactNode;
    onRetry?: () => void;
    children: ReactNode;
}): ReactNode {
    return null;
}

export function NavTabs(_props: {
    items: readonly { id: string; label: string; title?: string; icon?: unknown; badge?: ReactNode }[];
    value: string;
    onChange: (id: string) => void;
    className?: string;
    ripple?: boolean;
}): ReactNode {
    return null;
}

export function SegmentedControl<T extends string>(_props: {
    items: { key: T; label: string; icon?: string; badge?: number }[];
    value: T;
    onChange: (value: T | ((prev: T) => T)) => void;
    className?: string;
    suppressLayoutAnimation?: boolean;
    ripple?: boolean;
}): ReactNode {
    return null;
}

export function SidebarNavItemButton(
    _props: HTMLAttributes<HTMLButtonElement> & {
        item: {
            id: string;
            label?: string;
            title?: string;
            icon?: unknown;
            iconUrl?: string;
            active?: boolean;
            badge?: { text: string; variant?: "count" | "text" };
        };
        classNames?: { badge?: string; icon?: string; label?: string };
        ripple?: boolean;
    },
): ReactNode {
    return null;
}

/** The library's single icon entry: a component, an Iconify class string, or any node. */
export function IconSlot(_props: { source?: unknown; className?: string; size?: string | number }): ReactNode {
    return null;
}

export function MotionSelect(_props: {
    value: string;
    onValueChange: (value: string) => void;
    options: readonly { value: string; label: ReactNode; disabled?: boolean; title?: string }[];
    placeholder?: string;
    disabled?: boolean;
    triggerClassName?: string;
    "aria-label"?: string;
}): ReactNode {
    return null;
}

export function CodeBlock(_props: {
    code: string;
    lang?: string;
    language?: string;
    title?: ReactNode;
    className?: string;
}): ReactNode {
    return null;
}

export type DataTableColumn<T> = {
    key: string;
    header: ReactNode;
    render?: (row: T, index: number) => ReactNode;
    width?: string;
    align?: "left" | "right" | "center";
    numeric?: boolean;
    headerClassName?: string;
    cellClassName?: string;
};

export function DataTable<T>(_props: {
    columns: readonly DataTableColumn<T>[];
    rows: readonly T[];
    rowKey?: (row: T, index: number) => string | number;
    onRowClick?: (row: T) => void;
    loading?: boolean;
    empty?: ReactNode;
    emptyText?: string;
    maxHeight?: string;
    bare?: boolean;
    title?: ReactNode;
    actions?: ReactNode;
    className?: string;
}): ReactNode {
    return null;
}
