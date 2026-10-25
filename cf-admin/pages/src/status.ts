// Status values are contract strings; only the labels are translated.

export function statusVariant(status: string): "success" | "warning" | "secondary" | "destructive" {
    if (status === "passed" || status === "resolved" || status === "accepted") {
        return "success";
    }
    if (status === "failed") {
        return "destructive";
    }
    if (status === "warned" || status === "open" || status === "incomplete") {
        return "warning";
    }
    return "secondary";
}

const LABELS: Record<string, string> = {
    passed: "通过",
    warned: "有告警",
    failed: "失败",
    skipped: "跳过",
    incomplete: "未完成",
    open: "待处理",
    accepted: "已接受",
    rejected: "已驳回",
    resolved: "已解决",
};

/** An unknown status is shown as is: inventing a label would hide a contract change. */
export function statusLabel(status: string): string {
    return LABELS[status] ?? status;
}

export function severityLabel(severity: string): string {
    if (severity === "error") {
        return "错误";
    }
    return severity === "warning" ? "告警" : severity;
}

export function severityVariant(severity: string): "destructive" | "warning" | "secondary" {
    if (severity === "error") {
        return "destructive";
    }
    return severity === "warning" ? "warning" : "secondary";
}
