import { useState } from "react";
import type { FormEvent } from "react";
import { Alert, AlertDescription, AppFrame, Button, Card, CardContent, CardHeader, CardTitle, Input } from "@hx/ui";

type Props = { error: string | null; onSubmit: (user: string, password: string) => void };

/** Password comes from Worker vars. The form never stores a default password in the bundle. */
export function Login({ error, onSubmit }: Props) {
    const [busy, setBusy] = useState(false);
    const submit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        setBusy(true);
        onSubmit(String(data.get("user") ?? ""), String(data.get("password") ?? ""));
        setBusy(false);
    };
    return (
        <AppFrame contentClassName="items-center justify-center">
            <Card className="w-full max-w-sm" variant="solid">
                <CardHeader>
                    <CardTitle>hx-context-review</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                    <p className="text-[length:var(--fs-xs)] text-muted-foreground">
                        需要管理员口令才能查看总览。口令来自 Worker 变量, 不保存在页面里。
                    </p>
                    <form onSubmit={submit} className="flex flex-col gap-2.5">
                        <Input name="user" placeholder="用户名" autoComplete="username" required />
                        <Input
                            name="password"
                            type="password"
                            placeholder="口令"
                            autoComplete="current-password"
                            required
                        />
                        <Button type="submit" variant="primary" disabled={busy}>
                            登录
                        </Button>
                    </form>
                    {error ? (
                        <Alert variant="danger">
                            <AlertDescription>{error}</AlertDescription>
                        </Alert>
                    ) : null}
                </CardContent>
            </Card>
        </AppFrame>
    );
}
