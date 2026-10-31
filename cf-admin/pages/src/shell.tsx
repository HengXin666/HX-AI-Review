import type { ReactNode } from "react";
import {
    BarChart3,
    BookText,
    Bot,
    FileClock,
    FolderGit2,
    LayoutDashboard,
    ServerCog,
    Sparkles,
    TriangleAlert,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AppFrame, Badge, Button, NavTabs, PageHeader, SegmentedControl, SidebarNavItemButton } from "@hx/ui";
import type { Overview } from "./api.ts";
import { dateTime, shortSha } from "./format.ts";
import { KIND_FILTER_ITEMS } from "./kind.ts";
import type { KindFilter } from "./kind.ts";

/** One entry of the left rail. "overview" is the dashboard; the rest are the detail screens. */
export type SectionId =
    "overview" | "runs" | "findings" | "repos" | "providers" | "github" | "rules" | "prompts" | "deploy";

export type NavEntry = { id: SectionId; label: string; icon: LucideIcon; badge?: string };

/** Each entry carries an icon so the rail is scannable; eight labels alone looked alike. */
export function navEntries(openFindings: number): NavEntry[] {
    return [
        { id: "overview", label: "总览", icon: LayoutDashboard },
        { id: "runs", label: "审查", icon: FileClock },
        {
            id: "findings",
            label: "待处理发现",
            icon: TriangleAlert,
            badge: openFindings > 0 ? String(openFindings) : undefined,
        },
        { id: "repos", label: "仓库", icon: FolderGit2 },
        { id: "providers", label: "模型供应商", icon: ServerCog },
        { id: "github", label: "GitHub App", icon: Bot },
        { id: "rules", label: "规则统计", icon: BarChart3 },
        { id: "prompts", label: "提示词附录", icon: BookText },
        { id: "deploy", label: "部署", icon: Sparkles },
    ];
}

/** Top bar status strip: what is deployed and which month the budgets belong to. */
function StatusStrip({ data }: { data: Overview }) {
    const sha = data.deployment.sha;
    return (
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-[length:var(--fs-xs)] text-muted-foreground">
            <Badge variant={data.deployment.accessConfigured ? "success" : "warning"}>
                {data.deployment.accessConfigured ? "Access 已配置" : "Access 未配置"}
            </Badge>
            <span className="tabular-nums">{data.month}</span>
            {sha ? <span className="truncate font-mono">{shortSha(sha)}</span> : <span>未由工作流部署</span>}
            {data.deployment.deployedAt ? <span>{dateTime(data.deployment.deployedAt)}</span> : null}
        </div>
    );
}

/** One line per screen: what it is for, not how to use it. */
const SECTION_DESC: Record<SectionId, string> = {
    overview: "两种 CR 的健康度一屏看完: 错误与告警, 待处理发现, 花费与运行数。",
    runs: "打开一次运行，看步骤、按目录分的文件，以及每条发现的证据引用。",
    findings: "待处理发现可以接受或驳回; 驳回需要原因, 会写回抑制表。",
    repos: "登记仓库, 选择它跑哪种 CR, 并设置月度预算与令牌。",
    providers: "模型供应商的地址, 协议与单价; 密钥本身只在 Worker secret 里。",
    github: "登记一个 GitHub App。安装到仓库后，审查评论以这个 App 的身份发出。",
    rules: "按规则与等级汇总命中次数, 规则命名空间决定它属于哪种 CR。",
    prompts: "运维追加在系统提示词之后的附录, 以及待折叠的驳回记录。",
    deploy: "当前部署的提交, Access 配置状态与重新部署入口。",
};

function BUDGET_DESC(month: string): string {
    return `预算与花费按 ${month} 统计, 0 表示不设月度上限。`;
}

/** Screens whose numbers depend on the kind filter, so they all carry the same control. */
const FILTERED: SectionId[] = ["overview", "runs", "findings", "rules"];

type Props = {
    data: Overview;
    entries: NavEntry[];
    section: SectionId;
    filter: KindFilter;
    onFilter: (next: KindFilter | ((prev: KindFilter) => KindFilter)) => void;
    onSection: (id: SectionId) => void;
    onLogout: () => void;
    children: ReactNode;
};

/**
 * Application shell: a fixed left rail plus a scrolling content column.
 *
 * AppFrame owns the outer padding and the full-height layout, so no screen writes its own
 * "mx-auto max-w-6xl p-6" wrapper. The rail is a plain column of SidebarNavItemButton, which keeps
 * the selected state on aria-current through the library component.
 */
export function Shell({ data, entries, section, filter, onFilter, onSection, onLogout, children }: Props) {
    return (
        <AppFrame>
            <div className="flex min-h-0 w-full gap-2">
                <aside className="hidden w-52 shrink-0 flex-col gap-1 overflow-y-auto rounded-xl border border-border/50 bg-card/40 p-2 backdrop-blur-sm md:flex">
                    <div className="px-2 py-1.5">
                        <div className="text-[length:var(--fs-sm)] font-semibold text-heading">hx-context-review</div>
                        <div className="text-[length:var(--fs-2xs)] text-muted-foreground">上下文 CR 与代码 CR</div>
                    </div>
                    <nav aria-label="主导航" className="flex flex-col gap-0.5">
                        {entries.map((entry) => (
                            <SidebarNavItemButton
                                key={entry.id}
                                item={{
                                    id: entry.id,
                                    label: entry.label,
                                    icon: entry.icon,
                                    active: entry.id === section,
                                    badge: entry.badge ? { text: entry.badge, variant: "count" } : undefined,
                                }}
                                onClick={() => onSection(entry.id)}
                            />
                        ))}
                    </nav>
                    <div className="mt-auto flex flex-col gap-2 px-2 pt-2">
                        <StatusStrip data={data} />
                        <Button type="button" variant="outline" size="sm" onClick={onLogout}>
                            退出登录
                        </Button>
                    </div>
                </aside>
                <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
                    {/* The rail is hidden below md, so the same sections become a horizontal strip there. */}
                    <NavTabs
                        className="mb-2 flex-wrap md:hidden"
                        items={entries.map((entry) => ({
                            id: entry.id,
                            label: entry.label,
                            icon: entry.icon,
                            badge: entry.badge ? <Badge variant="secondary">{entry.badge}</Badge> : undefined,
                        }))}
                        value={section}
                        onChange={(id) => onSection(id as SectionId)}
                    />
                    <PageHeader
                        title={entries.find((entry) => entry.id === section)?.label ?? "总览"}
                        desc={SECTION_DESC[section] ?? BUDGET_DESC(data.month)}
                        right={
                            <div className="flex items-center gap-2 md:hidden">
                                <Button type="button" variant="outline" size="sm" onClick={onLogout}>
                                    退出登录
                                </Button>
                            </div>
                        }
                    />
                    {FILTERED.includes(section) ? (
                        <div className="mb-3 flex flex-wrap items-center gap-2">
                            <div role="group" aria-label="按 CR 类型筛选">
                                <SegmentedControl items={KIND_FILTER_ITEMS} value={filter} onChange={onFilter} />
                            </div>
                            <span className="text-[length:var(--fs-2xs)] text-muted-foreground">
                                按 CR 类型筛选本页的数字与列表
                            </span>
                        </div>
                    ) : null}
                    <div className="flex min-h-0 flex-1 flex-col gap-3 pb-4">{children}</div>
                </div>
            </div>
        </AppFrame>
    );
}
