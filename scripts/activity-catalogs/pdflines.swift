// Vuelca las líneas visuales de un PDF con su posición, una por renglón:
// "pagina|y|xInicio|xFin|texto" (PDFKit, macOS, sin dependencias externas).
// Uso: swiftc -O -o /tmp/pdflines pdflines.swift && /tmp/pdflines <archivo.pdf> > salida.lines
// Ver pdf-table.ts.
import Foundation
import PDFKit
let doc = PDFDocument(url: URL(fileURLWithPath: CommandLine.arguments[1]))!
for p in 0..<doc.pageCount {
    guard let page = doc.page(at: p), let all = page.selection(for: page.bounds(for: .mediaBox)) else { continue }
    for line in all.selectionsByLine() {
        let b = line.bounds(for: page)
        let s = (line.string ?? "").replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
        if s.isEmpty { continue }
        print(String(format: "%d|%.1f|%.1f|%.1f|", p + 1, b.midY, b.minX, b.maxX) + s)
    }
}
