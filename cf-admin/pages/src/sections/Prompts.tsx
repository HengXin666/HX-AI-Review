import { useState } from "react";
import type { FormEvent } from "react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, EmptyState, Input, Textarea } from "@hx/ui";
import { api } from "../api.ts";
import type { PromptNote, PromptVersion } from "../api.ts";

type Props = {
    prompts: PromptVersion[];
    notes: PromptNote[];
    onDone: () => void;
    onError: (error: Error) => void;
};

/**
 * Operator addenda. Publishing never replaces the runner system prompt, and cannot create Errors.
 * The role picker stays English because finder / verifier are contract names, not UI labels.
 */
export function Prompts({ prompts, notes, onDone, onError }: Props) {
    const [role, setRole] = useState<"finder" | "verifier">("finder");
    const publish = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        const body = String(data.get("body") ?? "");
        const note = String(data.get("note") ?? "");
        api.publishPrompt(role, body, note).then(() => {
            form.reset();
            onDone();
        }, onError);
    };
    const open = notes.filter((item) => item.foldedInto === null);
    const active = prompts.filter((item) => item.active);
    return (
        <Card>
            <CardHeader className="flex flex-row items-center gap-2">
                <CardTitle>提示词附录</CardTitle>
                <span className="ml-auto text-[length:var(--fs-2xs)] text-muted-foreground">
                    只追加在内置系统提示词之后, 不会替换它
                </span>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
                {active.length === 0 ? (
                    <EmptyState
                        compact
                        text="还没有生效的附录"
                        hint="发布后会追加到 finder / verifier 的系统提示词末尾。"
                    />
                ) : (
                    <ul className="flex flex-col gap-1.5">
                        {active.map((item) => (
                            <li key={item.id} className="flex items-center gap-2 text-[length:var(--fs-xs)]">
                                <Badge variant="secondary">{item.role}</Badge>
                                <span className="tabular-nums text-muted-foreground">v{item.version}</span>
                                <span className="truncate">{item.note}</span>
                            </li>
                        ))}
                    </ul>
                )}
                <form onSubmit={publish} className="flex flex-col gap-2 border-t border-border/50 pt-3">
                    <div className="flex flex-wrap items-center gap-2">
                        <select
                            aria-label="角色"
                            className="h-8 rounded-lg border border-border bg-card px-2 text-[length:var(--fs-xs)] text-foreground"
                            value={role}
                            onChange={(event) => setRole(event.target.value as "finder" | "verifier")}
                        >
                            <option value="finder">finder</option>
                            <option value="verifier">verifier</option>
                        </select>
                        <Input name="note" placeholder="版本说明" className="w-56" aria-label="版本说明" />
                    </div>
                    <Textarea name="body" placeholder="追加在内置系统提示词之后的内容" aria-label="附录正文" required />
                    <div className="flex flex-wrap items-center gap-2">
                        <Button type="submit" variant="primary">
                            发布
                        </Button>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => api.foldNotes(role).then(onDone, onError)}
                        >
                            合并 {open.length} 条驳回记录
                        </Button>
                        <span className="text-[length:var(--fs-2xs)] text-muted-foreground">
                            合并会把未归档的驳回原因折进下一版提示词。
                        </span>
                    </div>
                </form>
            </CardContent>
        </Card>
    );
}
