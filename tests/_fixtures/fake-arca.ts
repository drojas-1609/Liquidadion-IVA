import type { BrowserContext, Route } from "playwright-core";

/**
 * ARCA simulado para probar el conector sin tocar el organismo. Todas las
 * personas, CUIT e importes son SINTÉTICOS. Las pantallas reproducen la
 * estructura observada el 14/11/2026 (sólo lo que el conector usa):
 *  - Mis Comprobantes (fes.afip.gob.ar/mcmp): selector de persona, consulta por
 *    rango de fechas (Enter cierra el calendario sin enviar la consulta), panel
 *    «Filtro Aplicado» y «Exportar como CSV»;
 *  - versión anterior de Mis Retenciones (seti.afip.gob.ar/misret): rótulos con
 *    espacios duros, radios que el propio formulario oculta según el impuesto,
 *    botón cuyo valor es «Consultar», resultado sin encabezado cuando no hay
 *    datos y «Exportar a Texto» que abre el contenido en la misma pestaña.
 */
export interface FakeArcaOptions {
    loginCuit: string;
    loginName: string;
    /** Personas que el usuario puede representar (además de sí mismo). */
    represented: Array<{ cuit: string; name: string }>;
    /** Persona que cada servicio muestra como activa; por defecto, la elegida. */
    activeOverride?: string;
    /** Rango que Mis Comprobantes dice haber aplicado; por defecto, el pedido. */
    appliedRangeOverride?: string;
    vouchers?: { emitidos?: Uint8Array | null; recibidos?: Uint8Array | null };
    /** Texto de la exportación por impuesto y tipo ("216:Retencion"); sin clave no hay datos. */
    taxExports?: Record<string, Uint8Array>;
    /** "inline": el texto se abre en la pestaña (observado). "download": llega como descarga. */
    taxExportMode?: "inline" | "download";
    /** La sesión de la versión anterior figura vencida. */
    legacySessionExpired?: boolean;
}

export interface FakeArcaLog {
    voucherQueries: Array<{ kind: string; range: string; cuit: string }>;
    taxQueries: Array<Record<string, string>>;
    taxExports: Array<Record<string, string>>;
}

const dashed = (cuit: string) => `${cuit.slice(0, 2)}-${cuit.slice(2, 10)}-${cuit.slice(10)}`;
const html = (body: string, head = "") => `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>ARCA simulado</title>${head}</head><body>${body}</body></html>`;

export function fakeArca(options: FakeArcaOptions) {
    const log: FakeArcaLog = { voucherQueries: [], taxQueries: [], taxExports: [] };
    const people = [{ cuit: options.loginCuit, name: options.loginName }, ...options.represented];
    let voucherPerson = options.loginCuit;

    const loginPage = () => html(`
        <div id="uno"><label>CUIT <input type="number" id="cuit"></label><button type="button" id="sig">Siguiente</button></div>
        <div id="dos" hidden><label>Clave <input type="password" id="clave"></label><button type="button" id="ing">Ingresar</button></div>
        <script>
            document.getElementById("sig").onclick = () => { document.getElementById("uno").hidden = true; document.getElementById("dos").hidden = false; };
            document.getElementById("ing").onclick = () => { location.href = "https://portalcf.cloud.afip.gob.ar/portal/app/"; };
        </script>`);

    const portalPage = () => html(`
        <header>${options.loginName} [${dashed(options.loginCuit)}]</header>
        <input type="text" placeholder="¿Qué necesitás? | Buscá trámites y servicios">
        <nav>
            <a target="_blank" href="https://fes.afip.gob.ar/mcmp/jsp/index.do">Mis Comprobantes</a>
            <a target="_blank" href="https://mirequa-web.arca.gob.ar/">Mis Retenciones</a>
        </nav>`);

    // ---- Mis Comprobantes ----
    const voucherHeader = () => {
        const shown = options.activeOverride ?? voucherPerson;
        const person = people.find((p) => p.cuit === shown) ?? { cuit: shown, name: "OTRA PERSONA" };
        const representing = shown === options.loginCuit ? "" : `<span class="nombre-activo"><small>REPRESENTANDO A: <b>${person.name}</b> [${dashed(person.cuit)}]</small></span>`;
        return `<div id="usernav"><span>${options.loginName} [${dashed(options.loginCuit)}]</span>${representing}</div>`;
    };
    const chooserPage = () => html(`
        <h2>Elegí una persona para ingresar</h2>
        <a class="panel actual" href="#" onclick="return false"><h3>${options.loginName} <small>${dashed(options.loginCuit)}</small></h3></a>
        <h4>REPRESENTAR A:</h4>
        ${people.map((p, i) => `<a class="panel panel-default hoverazul" href="#" onclick="location.href='setearContribuyente.do?idContribuyente=${i}';return false"><h3>${p.name} <small>${dashed(p.cuit)}</small></h3></a>`).join("")}`);
    const voucherMenu = () => html(`${voucherHeader()}
        <a href="comprobantesEmitidos.do"><h3>Emitidos</h3><p>Comprobantes Emitidos</p></a>
        <a href="comprobantesRecibidos.do"><h3>Recibidos</h3><p>Comprobantes Recibidos</p></a>`);
    const voucherQuery = (kind: "emitidos" | "recibidos") => {
        const file = options.vouchers?.[kind];
        const role = kind === "emitidos" ? "Emisor" : "Receptor";
        return html(`${voucherHeader()}
        <ul class="nav nav-tabs"><li class="active"><a href="#tabConsulta">Consulta</a></li><li><a href="#tabResultados">Resultados</a></li></ul>
        <div id="tabConsulta"><form onsubmit="return false">
            <label for="fechaEmision">Fecha del Comprobante</label><input type="text" id="fechaEmision" value="13/11/2026 - 13/11/2026" onkeydown="if (event.key === 'Enter') event.preventDefault()">
            <button type="submit" id="buscarComprobantes">Buscar</button>
        </form></div>
        <div id="tabResultados" hidden>
            <div class="panel panel-primary"><div class="panel-heading">Filtro Aplicado</div><ul><li id="filtroFecha"></li><li>${role}: <b>${voucherPerson}</b></li></ul></div>
            <button type="button" title="Exportar como CSV" id="csv">CSV</button>
            <table id="tablaDataTables"><tbody>${file ? "<tr><td>01/10/2026</td></tr>" : `<tr><td class="dataTables_empty">No existe información para los filtros ingresados</td></tr>`}</tbody></table>
            <div class="dataTables_info">${file ? "Mostrando registros 1 al 1 de un total de 1" : "Mostrando 0 registros de un total de 0"}</div>
        </div>
        <script>
            const override = ${JSON.stringify(options.appliedRangeOverride ?? null)};
            document.getElementById("buscarComprobantes").onclick = () => {
                const range = override || document.getElementById("fechaEmision").value;
                const [from, to] = range.split(" - ");
                document.getElementById("filtroFecha").innerHTML = "Fecha del Comprobante: <b>" + from + "</b>" + (to && to !== from ? " a <b>" + to + "</b>" : "");
                fetch("consulta.do?kind=${kind}&range=" + encodeURIComponent(document.getElementById("fechaEmision").value)).then(() => {
                    document.getElementById("tabConsulta").hidden = true;
                    document.getElementById("tabResultados").hidden = false;
                });
            };
            document.getElementById("csv").onclick = () => { location.href = "exportar.do?kind=${kind}"; };
        </script>`);
    };

    // ---- Mis Retenciones, versión anterior ----
    const legacyChrome = (content: string) => `<!doctype html><html><head><meta charset="windows-1252"><title>Mis Retenciones</title>
        <style>.inputbutton { text-transform: uppercase; }</style></head><body>
        <div>Usuario: ${dashed(options.loginCuit)} Autenticante: ARCA</div>${content}</body></html>`;
    const legacyForm = () => legacyChrome(`
        <form name="formulario" method="post" action="consultaMisRetenciones.do">
        <table>
            <tr><td>CUIT del retenido&nbsp; :&nbsp; </td><td><select name="cuitRetenido" id="cuitRetenido">
                <option value="">Seleccione una CUIT...</option>${people.map((p) => `<option value="${p.cuit}">${p.cuit}</option>`).join("")}</select></td></tr>
            <tr><td>Impuesto retenido&nbsp; :&nbsp; </td><td><input type="text" name="impuesto" size="3" onchange="setRetencionPercepcion(formulario, impuesto.value)">
                <select id="impuestos" onchange="formulario.impuesto.value = this.value; setRetencionPercepcion(formulario, this.value)">
                    <option value=""></option><option value="216">216 - SIRE - IVA</option><option value="217">217 - SICORE-IMPTO.A LAS GANANCIAS</option>
                    <option value="767">767 - SICORE - RETENCIONES Y PERCEPC</option></select></td></tr>
            <tr><td>Retenci&oacute;n&nbsp; :&nbsp; <input type="radio" name="retencionPercepcion" value="Retencion"> &nbsp; Percepci&oacute;n&nbsp; <input type="radio" name="retencionPercepcion" value="Percepcion"></td>
                <td>Retenci&oacute;n y/o Percepci&oacute;n&nbsp; :&nbsp; <input type="radio" name="retencionPercepcion" value="RetencionPercepcion" checked></td></tr>
            <tr><td>Fecha Ret./Perc.&nbsp; :&nbsp; </td><td>Desde : <input type="text" name="fechaRetencionDesde" value="01012026"> Hasta : <input type="text" name="fechaRetencionHasta" value="14112026"> (ddMMaaaa)</td></tr>
            <tr><td>Fecha Comprobante&nbsp; :&nbsp; </td><td>Desde : <input type="text" name="fechaComprobanteDesde"> Hasta : <input type="text" name="fechaComprobanteHasta"></td></tr>
        </table>
        <input class="inputbutton" type="submit" title="Consultar Mis Retenciones" value="Consultar">
        </form>
        <script>
            // Mismo criterio que el formulario real: según el impuesto, oculta radios.
            function setRetencionPercepcion(frm, value) {
                const r = frm.retencionPercepcion;
                if (["217", "219", "767", "787", ""].includes(value)) { r[2].checked = true; for (const x of r) x.style.visibility = ""; }
                else { r[0].checked = true; r[0].style.visibility = ""; r[1].style.visibility = "hidden"; r[2].style.visibility = "hidden"; }
            }
        </script>`);
    const taxLabel: Record<string, string> = { "216": "216 - SIRE - IVA", "767": "767 - SICORE - RETENCIONES Y PERCEPCIONES - IMPUESTO AL VALOR AGRE" };
    const display = (value: string) => `${value.slice(0, 2)}/${value.slice(2, 4)}/${value.slice(4)}`;
    const legacyResult = (query: Record<string, string>) => {
        const key = `${query.impuesto}:${query.retencionPercepcion}`;
        if (!options.taxExports?.[key]) {
            return legacyChrome(`<p>No se han encontrado datos para esta consulta o los par&aacute;metros ingresados corresponden a retenciones /percepciones con importe en cero</p><input type="button" value="Volver">`);
        }
        const params = new URLSearchParams({ method: "exportTexto", ...query }).toString();
        return legacyChrome(`
            <table><tr><td>CUIT del Retenido&nbsp; :&nbsp; </td><td>${options.activeOverride ?? query.cuitRetenido}</td></tr>
            <tr><td>Impuesto retenido&nbsp; :&nbsp; </td><td>${taxLabel[query.impuesto] ?? query.impuesto}</td></tr>
            <tr><td>Fecha desde de la ret./perc.&nbsp; :&nbsp; </td><td>${display(query.fechaRetencionDesde)}</td></tr>
            <tr><td>Fecha hasta de la ret./perc.&nbsp; :&nbsp; </td><td>${display(query.fechaRetencionHasta)}</td></tr></table>
            <a href="javascript:go('consultaMisRetenciones.do?${params}')">Exportar a Texto</a>
            <script>function go(url) { location.href = url; }</script>`);
    };

    async function handle(route: Route) {
        const request = route.request();
        const url = new URL(request.url());
        const page = (body: string, contentType = "text/html; charset=utf-8") => route.fulfill({ status: 200, contentType, body });
        if (url.hostname === "auth.afip.gob.ar") return page(loginPage());
        if (url.hostname === "portalcf.cloud.afip.gob.ar") return page(portalPage());
        if (url.hostname === "mirequa-web.arca.gob.ar") {
            return page(html(`<h1>Mis retenciones</h1><div role="alert">Podés acceder a la versión anterior del servicio haciendo
                <button type="button" onclick="location.href='https://seti.afip.gob.ar/misret/consultaMisRetenciones.do?method=getForm'">click aquí</button></div>`));
        }
        if (url.hostname === "fes.afip.gob.ar") {
            const name = url.pathname.split("/").pop();
            if (name === "index.do") return page(chooserPage());
            if (name === "setearContribuyente.do") {
                voucherPerson = people[Number(url.searchParams.get("idContribuyente"))]?.cuit ?? options.loginCuit;
                return page(voucherMenu());
            }
            if (name === "comprobantesEmitidos.do") return page(voucherQuery("emitidos"));
            if (name === "comprobantesRecibidos.do") return page(voucherQuery("recibidos"));
            if (name === "consulta.do") {
                log.voucherQueries.push({ kind: url.searchParams.get("kind")!, range: url.searchParams.get("range")!, cuit: voucherPerson });
                return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
            }
            if (name === "exportar.do") {
                const file = options.vouchers?.[url.searchParams.get("kind") as "emitidos" | "recibidos"];
                return route.fulfill({
                    status: 200, contentType: "application/zip", body: Buffer.from(file ?? new Uint8Array()),
                    headers: { "Content-Disposition": `attachment; filename="comprobantes_consulta_csv_${url.searchParams.get("kind")}.zip"` },
                });
            }
        }
        if (url.hostname === "seti.afip.gob.ar" && url.pathname === "/misret/consultaMisRetenciones.do") {
            if (options.legacySessionExpired) return page(legacyChrome("<p>Usted no se encuentra logueado</p>"), "text/html; charset=windows-1252");
            const method = url.searchParams.get("method");
            if (request.method() === "POST") {
                const query = Object.fromEntries(new URLSearchParams(request.postData() ?? ""));
                log.taxQueries.push(query);
                return route.fulfill({ status: 200, contentType: "text/html; charset=windows-1252", body: Buffer.from(legacyResult(query), "latin1") });
            }
            if (method === "exportTexto") {
                const query = Object.fromEntries(url.searchParams);
                log.taxExports.push(query);
                const body = Buffer.from(options.taxExports?.[`${query.impuesto}:${query.retencionPercepcion}`] ?? new Uint8Array());
                return route.fulfill({
                    status: 200, contentType: "text/plain; charset=windows-1252", body,
                    headers: options.taxExportMode === "download" ? { "Content-Disposition": `attachment; filename="consultaMisRetenciones.txt"` } : {},
                });
            }
            return route.fulfill({ status: 200, contentType: "text/html; charset=windows-1252", body: Buffer.from(legacyForm(), "latin1") });
        }
        return route.fulfill({ status: 404, contentType: "text/plain", body: "sin simular" });
    }

    return { log, install: (context: BrowserContext) => context.route("**/*", handle) };
}

/** Exportación sintética de «Exportar a Texto»: tabulada, con relleno y en windows-1252. */
export function syntheticTaxText(rows: Array<{ agent: string; tax: string; regime: string; date: string; certificate: string; operation: string; amount: string; number: string }>): Uint8Array {
    const header = ["CUIT Agente Ret./Perc.", "Denominación o Razón Social".padEnd(60), "Impuesto", "Descripción Impuesto".padEnd(60), "Rgimen",
        "Descripción Régimen".padEnd(60), "Fec. Ret./Perc.", "Nro. Certificado", "Desc. Operación", "Imp. Ret./Perc.", "Nro. Comprobante",
        "Fec. Comprobante", "Desc. Comprobante".padEnd(40), "Fec. Registración DJ Ag.Ret.", ""].join("\t");
    const lines = rows.map((r) => [r.agent.padEnd(22), "AGENTE SINTETICO SA".padEnd(60), r.tax.padStart(8), "IMPUESTO DE PRUEBA".padEnd(60), r.regime.padStart(7),
        "REGIMEN DE PRUEBA".padEnd(60), r.date.padStart(15), r.certificate.padStart(25), r.operation.padEnd(15), r.amount.padStart(15), r.number.padStart(16),
        r.date.padStart(16), "FACTURA".padEnd(40), "06/11/2026".padStart(28), ""].join("\t"));
    return Buffer.from([header, ...lines].join("\n") + "\n", "latin1");
}
