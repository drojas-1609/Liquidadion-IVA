import "server-only";
import { extractText, getDocumentProxy } from "unpdf";

/** Texto de un PDF (todas las páginas unidas). Lanza si el archivo no es un PDF legible. */
export async function pdfText(bytes: Uint8Array): Promise<string> {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: true });
    return Array.isArray(text) ? text.join("\n") : text;
}
