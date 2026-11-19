/**
 * Ley 27.541, art. 22 — Anexo I: puntos porcentuales de reconocimiento de IVA
 * sobre las bases imponibles de las contribuciones patronales, por código zonal.
 * Transcripto del texto de la ley (Senado de la Nación, págs. 51–53) que aportó
 * el estudio el 19/11/2026. Faltan los códigos 27, 28, 58 y 59 (no figuran en
 * las páginas recibidas): no se ofrecen hasta verificarlos en la fuente oficial.
 */
export interface AnnexIZone { code: number; name: string; percent: string }

const RAW: [number, string, string][] = [
    [1, "CIUDAD AUTÓNOMA DE BUENOS AIRES", "0.00"], [2, "GRAN BUENOS AIRES", "0.00"], [3, "TERCER CINTURÓN DEL GBA", "0.65"],
    [4, "RESTO DE BUENOS AIRES", "1.45"], [5, "BS. AS. - PATAGONES", "2.20"], [6, "BS. AS. - CARMEN DE PATAGONES", "3.00"],
    [7, "CÓRDOBA - CRUZ DEL EJE", "3.80"], [8, "BS. AS. - VILLARINO", "2.20"], [9, "GRAN CATAMARCA", "5.70"],
    [10, "RESTO DE CATAMARCA", "6.50"], [11, "CIUDAD DE CORRIENTES", "7.30"], [12, "FORMOSA - CIUDAD DE FORMOSA", "8.05"],
    [13, "CÓRDOBA - SOBREMONTE", "5.70"], [14, "RESTO DE CHACO", "8.85"], [15, "CÓRDOBA - RÍO SECO", "5.70"],
    [16, "CÓRDOBA - TULUMBA", "5.70"], [17, "CÓRDOBA - MINAS", "3.80"], [18, "CÓRDOBA - POCHO", "3.80"],
    [19, "CÓRDOBA - SAN ALBERTO", "3.80"], [20, "CÓRDOBA - SAN JAVIER", "3.80"], [21, "GRAN CÓRDOBA", "1.45"],
    [22, "RESTO DE CÓRDOBA", "2.20"], [23, "CORRIENTES - ESQUINA", "5.70"], [24, "CORRIENTES - SAUCE", "5.70"],
    [25, "CORRIENTES - CURUZÚ CUATIÁ", "5.70"], [26, "CORRIENTES - MONTE CASEROS", "5.70"],
    [29, "CHUBUT - RAWSON - TRELEW", "5.70"], [30, "RESTO DE CHUBUT", "6.50"], [31, "ENTRE RÍOS - FEDERACIÓN", "5.70"],
    [32, "ENTRE RÍOS - FELICIANO", "5.70"], [33, "ENTRE RÍOS - PARANÁ", "2.20"], [34, "RESTO DE ENTRE RÍOS", "3.00"],
    [35, "JUJUY - CIUDAD DE JUJUY", "7.30"], [36, "RESTO DE JUJUY", "8.05"], [37, "LA PAMPA - CHICALCO", "3.80"],
    [38, "LA PAMPA - CHALILEO", "3.80"], [39, "LA PAMPA - PUELÉN", "3.80"], [40, "LA PAMPA - LIMAY MAHUIDA", "3.80"],
    [41, "LA PAMPA - CURACÓ", "3.80"], [42, "LA PAMPA - LIHUEL CALEL", "3.80"], [43, "LA PAMPA - SANTA ROSA Y TOAY", "2.20"],
    [44, "RESTO DE LA PAMPA", "3.00"], [45, "CIUDAD DE LA RIOJA", "5.70"], [46, "RESTO DE LA RIOJA", "6.50"],
    [47, "GRAN MENDOZA", "3.00"], [48, "RESTO DE MENDOZA", "3.80"], [49, "MISIONES - POSADAS", "7.30"],
    [50, "RESTO DE MISIONES", "8.05"], [51, "CIUDAD NEUQUÉN/PLOTTIER", "3.00"], [52, "NEUQUÉN - CENTENARIO", "3.00"],
    [53, "NEUQUÉN - CUTRAL CO", "6.50"], [54, "NEUQUÉN - PLAZA HUINCUL", "6.50"], [55, "RESTO DE NEUQUÉN", "3.80"],
    [56, "RÍO NEGRO SUR HASTA PARALELO 42", "6.50"], [57, "RÍO NEGRO - VIEDMA", "3.00"],
    [60, "GRAN SALTA", "7.30"], [61, "RESTO DE SALTA", "8.05"], [62, "GRAN SAN JUAN", "3.80"], [63, "RESTO DE SAN JUAN", "5.70"],
    [64, "CIUDAD DE SAN LUIS", "3.00"], [65, "RESTO DE SAN LUIS", "3.80"], [66, "SANTA CRUZ - CALETA OLIVIA", "6.50"],
    [67, "SANTA CRUZ - RÍO GALLEGOS", "6.50"], [68, "RESTO DE SANTA CRUZ", "7.30"], [69, "SANTA FE - GENERAL OBLIGADO", "5.70"],
    [70, "SANTA FE - SAN JAVIER", "5.70"], [71, "SANTA FE Y SANTO TOMÉ", "2.20"], [72, "SANTA FE - 9 DE JULIO", "5.70"],
    [73, "SANTA FE - VERA", "5.70"], [74, "RESTO DE SANTA FE", "2.20"], [75, "CIUDAD DE SGO. DEL ESTERO Y LA BANDA", "8.05"],
    [76, "SGO. DEL ESTERO - OJO DE AGUA", "5.70"], [77, "SGO. DEL ESTERO - QUEBRACHOS", "5.70"], [78, "SGO. DEL ESTERO - RIVADAVIA", "5.70"],
    [79, "TIERRA DEL FUEGO - RÍO GRANDE", "6.50"], [80, "TIERRA DEL FUEGO - USHUAIA", "6.50"], [81, "RESTO DE TIERRA DEL FUEGO", "7.30"],
    [82, "GRAN TUCUMÁN", "5.70"], [83, "RESTO DE TUCUMÁN", "6.50"], [84, "RESTO DE SGO. DEL ESTERO", "8.85"],
    [85, "RESTO DE FORMOSA", "8.85"],
];

export const ANNEX_I_ZONES: readonly AnnexIZone[] = RAW.map(([code, name, percent]) => ({ code, name, percent }));
const BY_CODE = new Map(ANNEX_I_ZONES.map((z) => [z.code, z]));
export const annexIZone = (code: number | null | undefined): AnnexIZone | null => (code == null ? null : BY_CODE.get(code) ?? null);
