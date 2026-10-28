import { describe, it, expect } from "vitest";
import { compareWithArcaWeb, parseArcaNomenclatorHtml } from "@/scripts/activity-catalogs/compare-arca-web";

/** HTML SINTÉTICO con la estructura del Nomenclador de Actividades en línea de ARCA. */
const HTML = `<html><script>var x = "011111:";</script><body>
<h3>ELABORACIÓN DE BEBIDAS</h3>
<li><b>110412: </b><span>Fabricaci&oacute;n de sodas</span></li>
<li><b>110420: </b><span>Elaboración de bebidas gaseosas, excepto soda</span></li>
<li><b>772099: </b><span>Alquiler de efectos personales n.c.p. (incluye alquiler de artículos deportivos)</span></li>
<li><b>000007: </b><span>Jubilado</span></li>
</body></html>`;

describe("cotejo con el nomenclador en línea de ARCA", () => {
    const web = parseArcaNomenclatorHtml(HTML);
    it("lee pares código/descripción, decodifica entidades e ignora scripts", () => {
        expect([...web.keys()]).toEqual(["110412", "110420", "772099", "000007"]);
        expect(web.get("110412")).toEqual(["Fabricación de sodas"]);
    });
    it("coincide si la descripción del catálogo es el comienzo del texto web (la web agrega «incluye…»)", () => {
        const r = compareWithArcaWeb(
            [
                { code: "110412", description: "Fabricación de sodas", reference: null },
                { code: "772099", description: "Alquiler de efectos personales n.c.p.", reference: null },
                { code: "110420", description: "Elaboración de bebidas gaseosas, excepto sodas y aguas", reference: null },
                { code: "999999", description: "No está en la web", reference: null },
            ],
            web,
        );
        expect(r.differences.map((d) => d.code)).toEqual(["110420"]);
        expect(r.onlyInCatalog).toEqual(["999999"]);
        expect(r.onlyInWeb).toEqual(["000007"]);
    });
});
