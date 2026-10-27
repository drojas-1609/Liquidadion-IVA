/**
 * Checksums de catálogos (sólo Node: scripts, tests y servidor).
 */
import { createHash } from "node:crypto";
import { entriesChecksumInput } from "./validate";
import type { CatalogEntry, CatalogFile } from "./types";

export function sha256Hex(data: string | Uint8Array): string {
    return createHash("sha256").update(data).digest("hex");
}

export function entriesSha256(entries: readonly CatalogEntry[]): string {
    return sha256Hex(entriesChecksumInput(entries));
}

/** Problemas de integridad: el checksum declarado no corresponde a las entradas. */
export function integrityProblems(file: CatalogFile): string[] {
    return entriesSha256(file.entries) === file.manifest.entriesSha256 ? [] : ["entriesSha256 no coincide con las entradas"];
}
