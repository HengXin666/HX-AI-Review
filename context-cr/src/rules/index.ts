import { ARCH_RULES } from "./arch.ts";
import { CI_RULES } from "./ci.ts";
import { CONTEXT_RULES } from "./context.ts";
import { DOC_RULES } from "./docs.ts";
import { registerRule, registeredRules } from "./registry.ts";
import { STYLE_RULES } from "./style.ts";
import type { Rule } from "./types.ts";

let loaded = false;

/** Register the built-in rule set once and return it in id order. */
export function rules(): Rule[] {
    if (!loaded) {
        for (const rule of [...ARCH_RULES, ...STYLE_RULES, ...DOC_RULES, ...CONTEXT_RULES, ...CI_RULES]) {
            registerRule(rule);
        }
        loaded = true;
    }
    return registeredRules();
}
