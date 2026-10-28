// Extrae el texto de un PDF con PDFKit (macOS, sin dependencias externas), una
// marca "=== PAGINA n ===" por página. Uso: swiftc -O -o /tmp/pdftext pdftext.swift
// && /tmp/pdftext <archivo.pdf> > salida.txt. Ver crosscheck-pdf.ts.
import Foundation
import PDFKit
let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let doc = PDFDocument(url: url) else { FileHandle.standardError.write("no se pudo abrir\n".data(using: .utf8)!); exit(1) }
var out = ""
for i in 0..<doc.pageCount { out += "\n=== PAGINA \(i + 1) ===\n" + (doc.page(at: i)?.string ?? "") }
print("paginas: \(doc.pageCount)")
print(out)
