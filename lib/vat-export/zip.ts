import "server-only";
import { deflateRawSync } from "node:zlib";

/**
 * Escritor ZIP mínimo (PKZIP 2.0: método 8 "deflate", sin cifrado ni ZIP64).
 * Determinista: fecha y hora fijas por parámetro (las del cierre), mismo orden
 * de archivos y mismas opciones de compresión, para que el mismo contenido
 * produzca los mismos bytes. Nombres ASCII (los archivos del paquete lo son).
 */

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

export function crc32(data: Uint8Array): number {
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d: Date): { time: number; date: number } {
    // Hora local de Argentina (UTC-3, sin horario de verano) para que coincida con lo que ve el estudio.
    const local = new Date(d.getTime() - 3 * 3600 * 1000);
    const time = (local.getUTCHours() << 11) | (local.getUTCMinutes() << 5) | Math.floor(local.getUTCSeconds() / 2);
    const date = ((local.getUTCFullYear() - 1980) << 9) | ((local.getUTCMonth() + 1) << 5) | local.getUTCDate();
    return { time, date };
}

export interface ZipEntry {
    name: string;
    data: Uint8Array;
}

export function writeZip(entries: ZipEntry[], when: Date): Uint8Array {
    const { time, date } = dosDateTime(when);
    const chunks: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;
    const seen = new Set<string>();
    for (const e of entries) {
        if (!/^[A-Za-z0-9._-]+$/.test(e.name)) throw new Error(`nombre de archivo no admitido en el paquete: ${e.name}`);
        if (seen.has(e.name)) throw new Error(`archivo repetido en el paquete: ${e.name}`);
        seen.add(e.name);
        const name = new TextEncoder().encode(e.name);
        const crc = crc32(e.data);
        const comp = new Uint8Array(deflateRawSync(e.data, { level: 9 }));
        const local = new Uint8Array(30 + name.length);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, 0x04034b50, true);
        lv.setUint16(4, 20, true);
        lv.setUint16(6, 0, true);
        lv.setUint16(8, 8, true);
        lv.setUint16(10, time, true);
        lv.setUint16(12, date, true);
        lv.setUint32(14, crc, true);
        lv.setUint32(18, comp.length, true);
        lv.setUint32(22, e.data.length, true);
        lv.setUint16(26, name.length, true);
        lv.setUint16(28, 0, true);
        local.set(name, 30);
        chunks.push(local, comp);

        const cen = new Uint8Array(46 + name.length);
        const cv = new DataView(cen.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true);
        cv.setUint16(6, 20, true);
        cv.setUint16(8, 0, true);
        cv.setUint16(10, 8, true);
        cv.setUint16(12, time, true);
        cv.setUint16(14, date, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, comp.length, true);
        cv.setUint32(24, e.data.length, true);
        cv.setUint16(28, name.length, true);
        cv.setUint32(42, offset, true);
        cen.set(name, 46);
        central.push(cen);
        offset += local.length + comp.length;
    }
    const cdSize = central.reduce((n, c) => n + c.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    const all = [...chunks, ...central, end];
    const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
    let p = 0;
    for (const c of all) {
        out.set(c, p);
        p += c.length;
    }
    return out;
}
