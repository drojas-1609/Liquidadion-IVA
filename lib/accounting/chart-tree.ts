import { ACCOUNT_ROLE_LABEL } from "./chart-models";

/**
 * Árbol del plan de cuentas para la pantalla (lógica pura): capítulo «1» →
 * rubro «1.01» → cuenta «1.01.02.01» → subcuenta «1.01.02.01.01».
 */

export type ChartLevel = "chapter" | "rubro" | "account" | "subaccount";

export interface TreeAccount {
    id: string;
    code: string;
    name: string;
    active: boolean;
    role: string | null;
}

export interface ChartNode<A extends TreeAccount = TreeAccount> {
    account: A;
    level: ChartLevel;
    children: ChartNode<A>[];
    /** Cuentas y subcuentas visibles debajo (para capítulos y rubros). */
    count: number;
}

export function chartLevel(code: string): ChartLevel {
    if (code.length === 1) return "chapter";
    if (code.length === 4) return "rubro";
    if (code.length === 10) return "account";
    return "subaccount";
}

function parentOf(code: string): string | null {
    if (code.length === 13) return code.slice(0, 10);
    if (code.length === 10) return code.slice(0, 4);
    if (code.length === 4) return code.slice(0, 1);
    return null;
}

function norm(s: string): string {
    return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function buildChartTree<A extends TreeAccount>(accounts: readonly A[], opts: { query?: string; includeInactive?: boolean } = {}): ChartNode<A>[] {
    const q = norm((opts.query ?? "").trim());
    const sorted = [...accounts].sort((a, b) => a.code.localeCompare(b.code));
    const nodes = new Map<string, ChartNode<A>>();
    const roots: ChartNode<A>[] = [];
    for (const a of sorted) {
        const node: ChartNode<A> = { account: a, level: chartLevel(a.code), children: [], count: 0 };
        nodes.set(a.code, node);
        const p = parentOf(a.code);
        const parent = p ? nodes.get(p) : undefined;
        if (parent) parent.children.push(node);
        else roots.push(node);
    }

    const matches = (a: A) =>
        !q || a.code.startsWith(q) || norm(a.name).includes(q) || (a.role !== null && norm(ACCOUNT_ROLE_LABEL[a.role as keyof typeof ACCOUNT_ROLE_LABEL] ?? a.role).includes(q));

    // Poda: queda el nodo si coincide (con todo lo de abajo) o si coincide algo debajo.
    function prune(n: ChartNode<A>, ancestorMatched: boolean): ChartNode<A> | null {
        if (!opts.includeInactive && !n.account.active) return null;
        const self = ancestorMatched || matches(n.account);
        const kids = n.children.map((c) => prune(c, self)).filter((c): c is ChartNode<A> => c !== null);
        if (!self && kids.length === 0) return null;
        const count = kids.reduce((s, k) => s + (k.level === "account" || k.level === "subaccount" ? 1 : 0) + k.count, 0);
        return { ...n, children: kids, count };
    }
    return roots.map((r) => prune(r, false)).filter((r): r is ChartNode<A> => r !== null);
}
