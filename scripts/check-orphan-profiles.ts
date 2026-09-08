/**
 * Verificación compensatoria de integridad Profile <-> auth.users.
 *
 * En 3A no hay FK ni trigger sobre el esquema `auth` (para que la migración
 * sea reproducible en bases shadow sin ese esquema). Este script — SOLO
 * LECTURA — reporta Profiles que quedaron sin su usuario de Auth.
 *
 * Uso:  node scripts/check-orphan-profiles.ts
 * Sale con código 1 si encuentra huérfanos (para poder usarlo en CI).
 */

export interface OrphanRow {
  id: string;
  email: string;
}

const ORPHAN_QUERY = `
  SELECT p.id::text AS id, p.email AS email
  FROM public."Profile" p
  LEFT JOIN auth.users u ON u.id = p.id
  WHERE u.id IS NULL
  ORDER BY p.email
`;

export async function findOrphanProfiles(db: {
  $queryRawUnsafe: (query: string) => Promise<OrphanRow[]>;
}): Promise<OrphanRow[]> {
  return db.$queryRawUnsafe(ORPHAN_QUERY);
}

async function main(): Promise<void> {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  try {
    const orphans = await findOrphanProfiles(
      prisma as unknown as { $queryRawUnsafe: (q: string) => Promise<OrphanRow[]> },
    );
    if (orphans.length === 0) {
      console.log("OK: no hay Profiles huérfanos.");
      process.exit(0);
    }
    console.error(`Se encontraron ${orphans.length} Profile(s) huérfano(s):`);
    for (const o of orphans) console.error(`  ${o.id}  ${o.email}`);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

if ((import.meta as unknown as { main?: boolean }).main) {
  void main();
}
