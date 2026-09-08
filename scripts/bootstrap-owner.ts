/**
 * Alta del PRIMER OWNER — modo `link` ÚNICAMENTE.
 *
 * Qué hace: crea la Organización ("Dero Company"), el Profile espejo de un
 * usuario de Supabase Auth QUE YA EXISTE, y su Membership OWNER, en una
 * transacción.
 *
 * Qué NO hace (por diseño): NO crea usuarios en Supabase Auth, NO recibe ni
 * setea contraseñas, NO expone `service_role` al bundle (este archivo vive en
 * scripts/, fuera de Next). El `service_role` se lee del entorno en runtime y
 * solo se usa para LEER el usuario (getUserById) y comparar el correo.
 *
 * Guardas: BOOTSTRAP_OWNER=1, --project-ref que coincide con la URL de
 * Supabase, --user-id UUID, --email de verificación (match-only),
 * Membership.count() === 0, y que no exista ya un Profile con ese id.
 * Una segunda ejecución aborta.
 *
 * Uso:
 *   BOOTSTRAP_OWNER=1 SUPABASE_SERVICE_ROLE_KEY=... \
 *   node scripts/bootstrap-owner.ts \
 *     --project-ref <ref> --user-id <uuid> --email <correo> [--org-name "Dero Company"]
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface BootstrapArgs {
  enabled: boolean;
  projectRef: string;
  userId: string;
  email: string;
  orgName: string;
}

export interface BootstrapTx {
  organization: { create: (a: { data: { name: string } }) => Promise<{ id: string }> };
  profile: { create: (a: { data: { id: string; email: string } }) => Promise<{ id: string }> };
  membership: {
    create: (a: {
      data: { profileId: string; organizationId: string; role: "OWNER" };
    }) => Promise<{ id: string }>;
  };
}

export interface BootstrapDeps {
  prisma: {
    membership: { count: () => Promise<number> };
    profile: { findUnique: (a: { where: { id: string } }) => Promise<{ id: string } | null> };
    $transaction: <T>(fn: (tx: BootstrapTx) => Promise<T>) => Promise<T>;
  };
  adminAuth: {
    getUserById: (
      id: string,
    ) => Promise<{ data: { user: { id: string; email?: string | null } | null }; error: unknown }>;
  };
  /** ref extraída de NEXT_PUBLIC_SUPABASE_URL (`https://<ref>.supabase.co`). */
  projectRefFromUrl: string;
}

export interface BootstrapResult {
  ok: boolean;
  message: string;
  organizationId?: string;
}

export async function runBootstrapOwner(
  args: BootstrapArgs,
  deps: BootstrapDeps,
): Promise<BootstrapResult> {
  if (!args.enabled) {
    return { ok: false, message: "Abortado: falta BOOTSTRAP_OWNER=1." };
  }
  if (!UUID_RE.test(args.userId)) {
    return { ok: false, message: "Abortado: --user-id no es un UUID válido." };
  }
  if (!EMAIL_RE.test(args.email)) {
    return { ok: false, message: "Abortado: --email no tiene formato válido." };
  }
  if (!args.projectRef) {
    return { ok: false, message: "Abortado: falta --project-ref." };
  }
  if (args.projectRef !== deps.projectRefFromUrl) {
    return {
      ok: false,
      message: `Abortado: --project-ref (${args.projectRef}) no coincide con la URL de Supabase (${deps.projectRefFromUrl}).`,
    };
  }

  const { data, error } = await deps.adminAuth.getUserById(args.userId);
  if (error || !data?.user) {
    return { ok: false, message: "Abortado: no existe un usuario de Auth con ese --user-id." };
  }
  const authEmail = (data.user.email ?? "").toLowerCase();
  if (authEmail !== args.email.toLowerCase()) {
    return {
      ok: false,
      message: "Abortado: el --email no coincide con el del usuario de Auth (verificación).",
    };
  }

  const members = await deps.prisma.membership.count();
  if (members !== 0) {
    return { ok: false, message: `Abortado: ya hay ${members} membership(s); el bootstrap es de un solo uso.` };
  }

  const existing = await deps.prisma.profile.findUnique({ where: { id: args.userId } });
  if (existing) {
    return { ok: false, message: "Abortado: ya existe un Profile con ese id." };
  }

  const organizationId = await deps.prisma.$transaction(async (tx) => {
    const org = await tx.organization.create({ data: { name: args.orgName } });
    await tx.profile.create({ data: { id: args.userId, email: args.email } });
    await tx.membership.create({
      data: { profileId: args.userId, organizationId: org.id, role: "OWNER" },
    });
    return org.id;
  });

  return {
    ok: true,
    message: `OK: Organización "${args.orgName}" creada y ${args.email} es OWNER.`,
    organizationId,
  };
}

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────

export function parseCliArgs(argv: string[]): Omit<BootstrapArgs, "enabled"> {
  const get = (name: string): string => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : "";
  };
  return {
    projectRef: get("project-ref"),
    userId: get("user-id"),
    email: get("email"),
    orgName: get("org-name") || "Dero Company",
  };
}

export function refFromSupabaseUrl(url: string | undefined): string {
  if (!url) return "";
  try {
    const host = new URL(url).hostname; // <ref>.supabase.co
    return host.split(".")[0] ?? "";
  } catch {
    return "";
  }
}

async function main(): Promise<void> {
  const { PrismaClient } = await import("@prisma/client");
  const { createClient } = await import("@supabase/supabase-js");

  const cli = parseCliArgs(process.argv.slice(2));
  const enabled = process.env.BOOTSTRAP_OWNER === "1";
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    console.error(
      "Faltan NEXT_PUBLIC_SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY en el entorno (runtime).",
    );
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const prisma = new PrismaClient();

  try {
    const result = await runBootstrapOwner(
      { ...cli, enabled },
      {
        prisma: prisma as unknown as BootstrapDeps["prisma"],
        adminAuth: {
          getUserById: (id) =>
            supabase.auth.admin.getUserById(id) as unknown as ReturnType<
              BootstrapDeps["adminAuth"]["getUserById"]
            >,
        },
        projectRefFromUrl: refFromSupabaseUrl(supabaseUrl),
      },
    );
    console[result.ok ? "log" : "error"](result.message);
    process.exit(result.ok ? 0 : 1);
  } finally {
    await prisma.$disconnect();
  }
}

if ((import.meta as unknown as { main?: boolean }).main) {
  void main();
}
