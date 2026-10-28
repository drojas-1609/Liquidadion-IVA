# Revisión pendiente de datos oficiales (preparada el 27/10/2026)

Nada de lo que sigue está aprobado. Los tres archivos están en `PENDIENTE_REVISION`, con **todos sus niveles en PENDIENTE**, y no se ofrecen en el buscador ni en la asistencia.

Los **checks** registrados en cada archivo (`manifest.review.levels.<nivel>.checks`) son resultados del preparador, cotejos y búsquedas, con su evidencia. **No son decisiones.**

## Cómo se revisa (tres niveles separados)

| Nivel | Qué decide el estudio | Aplica a |
|---|---|---|
| `technical` | Integridad y cotejo de códigos, descripciones o tasas contra la fuente | catálogos y reglas |
| `validity` | Vigencia normativa: versión vigente, modificaciones, derogaciones y fechas | catálogos y reglas |
| `interpretation` | Lectura de la norma convertida en reglas: alcance, condiciones y exclusiones | sólo reglas |

```bash
cli() { npx --no-install vite-node scripts/activity-catalogs/cli.ts -- "$@"; }
cli review  --file <archivo> --level technical|validity|interpretation --decision CONFORME|OBSERVADO --reviewer "<nombre>" --date AAAA-MM-DD [--notes "..."]
cli approve --file <archivo> --reviewer "<nombre>" --date AAAA-MM-DD      # sólo si todos los niveles están CONFORME
```

- Una observación exige notas.
- Cambiar un nivel de algo ya aprobado lo devuelve a pendiente.
- Un `REVISADO` con un nivel no conforme es inválido y no se publica.
- Las **reglas retenidas** (`pendingInterpretation`) no se usan ni siquiera con el conjunto aprobado. Para habilitarlas hay que regenerar el conjunto sin la marca, después de tu decisión.

**Evidencia persistente:** `~/Liquidador-evidencia-fiscal/2026-10-27-catalogos-alicuotas/` (ver su `LEEME.md` y `SHA256SUMS`). Las rutas de los checks son relativas a ese directorio.

---

## Nomenclador y alícuotas se revisan por separado

- **Catálogos** (NAES, CLAE, NAIIB-18): códigos y descripciones, con sus niveles `technical` y `validity`. Aprobarlos habilita **sólo la búsqueda de actividades** y la copia en la ficha.
- **Conjuntos de reglas** (CABA, Buenos Aires): tienen además `interpretation`. Aprobarlos habilita sólo la asistencia de alícuotas.
- **Las dudas sobre tasas no bloquean el catálogo:** los 222 códigos retenidos de ARBA y las retenciones de CABA afectan sólo a las sugerencias de tasas, no a los códigos ni a sus descripciones.
- **Un catálogo puede aprobarse sin su conjunto de reglas.** Al revés no: un conjunto de reglas usa un catálogo y no puede publicarse antes que él.

## Fichas de decisión

Cada ficha indica la fuente, el texto, la propuesta y su fundamento, qué falta acreditar y qué queda bloqueado mientras tanto. **Ninguna está resuelta.** Las páginas son del PDF oficial citado.

### CABA

**C1. Fecha de vigencia de la Ley 6948.**
- **Documento:** [Ley 6948, BOCBA 7369 (19/05/2026)](https://documentosboletinoficial.buenosaires.gob.ar/publico/ck_PL-LEY-LCABA-LCBA-6948-26-7369.pdf), art. 10, pág. 4: «Las disposiciones de la presente Ley entran en vigencia a partir del primer día hábil del mes siguiente al de su publicación».
- **Propuesta:** lunes 01/06/2026. La publicación es de mayo, así que el mes siguiente es junio, y el 01/06/2026 fue lunes y no es feriado nacional.
- **Falta acreditar:** que ese día fue hábil administrativo en CABA y que no hubo una norma aclaratoria (AGIP o Legislatura) con otra fecha.
- **Bloqueado:** las 14 reglas de junio a diciembre (Planillas 3, 5, 6 y 8 a 11): «Alícuota pendiente de determinar».

**C2. Alcance de los cambios de la Ley 6948.** Es una cuestión distinta de la fecha.
- **Documento:** misma ley. Los arts. 1° a 7° (págs. 1 a 3) sustituyen los arts. 3°, 5°, 6° y 8° a 11 del Anexo, con nuevos umbrales y las mismas tasas. El art. 9° (pág. 4) dice: «Se dispone la adecuación de las PLANILLAS ADJUNTAS DE ACTIVIDADES Nros. 3, 5, 6, 8, 9, 10 y 11 … de conformidad con las modificaciones establecidas en los artículos precedentes».
- **Propuesta:** la adecuación cambia los rótulos de umbral de las planillas y no qué códigos hay en cada una. Fundamento: los artículos sustituidos sólo cambian importes.
- **Falta acreditar:** si AGIP publicó planillas adecuadas y, en ese caso, cotejarlas.
- **Bloqueado:** las mismas 14 reglas. Para habilitarlas hacen falta C1 y C2.

**C3. Remisión del art. 3° al «artículo 58».**
- **Documento:** [Anexo de la Ley 6927, con fe de erratas](https://documentosboletinoficial.buenosaires.gob.ar/publico/PL-FEERR-LCABA-LCABA-6927-25-ANX.pdf).
  - Art. 3°, último párrafo, pág. 1: «exceptuando los correspondientes al inciso 20 del artículo 19 y al artículo 58 … consumidor residencial … 4,00%».
  - El inc. 20 del art. 19 (pág. 10) es «Distribución mayorista y/o minorista de gas licuado de petróleo en garrafas», que es coherente.
  - El art. 58 (pág. 24) es «Para determinar la tarifa de los carteles o anuncios publicitarios…», que no tiene relación aparente.
- **Propuesta:** ninguna. No se resuelve por suposición. Una explicación posible es una numeración heredada de una ley impositiva anterior, pero no está verificada.
- **Falta acreditar:** el texto equivalente en la Ley Impositiva 2025 y si hubo fe de erratas sobre este punto.
- **Bloqueado:** el 4 % residencial. Mientras tanto, la tasa general de la Planilla 3 nunca se presenta como única.

**C4. Arts. 12 a 21 y 26 (tratamientos especiales).** Fuera de alcance por ahora.
- **Bloqueado:** 39 códigos de planillas y los citados en esos artículos: sin regla.

### Provincia de Buenos Aires (ARBA)

**B1. Catálogo NAIIB-18, independiente de las tasas.**
- **Documentos:** [RN ARBA 38/2017](https://www.arba.gov.ar/archivos/Tramites/RN%2038-2017.pdf), art. 4° (desde el 1° anticipo de 2018), y [RN 34/2025](https://www.arba.gov.ar/archivos/Tramites/RN%2034-2025.pdf), arts. 1° a 5° (altas y bajas) y art. 12 (desde el 01/01/2026).
- **Propuesta:** los 1035 códigos y descripciones pueden revisarse y aprobarse para la búsqueda aunque las tasas sigan retenidas. Los 222 códigos retenidos son códigos válidos del nomenclador.
- **Falta acreditar:** modificaciones posteriores a la RN 34/2025.
- **Bloqueado:** nada propio. La búsqueda sólo depende de tu revisión del catálogo.

**B2. `bonif_actiba = S` (203 códigos).**
- **Documento:** exportación oficial de ARBA. Es un campo sin definición en la Ley 15.558: el art. 20 (pág. 6 y siguientes) no menciona bonificaciones por actividad.
- **Propuesta:** ninguna. No se asume su significado.
- **Falta acreditar:** la definición del campo (documentación de ARBA o norma).
- **Bloqueado:** las sugerencias de tasa de esos códigos.

**B3. `AlicuotaSUS` (49 filas con valor 2).**
- **Documento:** el mismo.
- **Propuesta:** ninguna.
- **Falta acreditar:** su significado.
- **Bloqueado:** las sugerencias de tasa de esos códigos.

**B4. Tratamientos especiales.**
- **Documentos:** [Ley 15.558](https://www.arba.gov.ar/archivos/Publicaciones/leyimpositiva2026.pdf).
  - Art. 22 (pág. 25): 1,5 % para 390000 y 812090 «cuando sean prestadas a los Municipios … por los mismos contribuyentes que desarrollen las actividades … 381100 y 381200».
  - Art. 134 (pág. 89): 2 % para las actividades del art. 184 bis del Código Fiscal, y 15 % para juegos de azar en línea.
- **Propuesta:** que sean alternativas excluyentes de los tramos, sujetas a un hecho declarado.
- **Falta acreditar:** el texto del art. 184 bis del Código Fiscal, que no revisé.
- **Bloqueado:** 390000, 812090 y 631201 a 631204.

**B5. Condiciones del art. 20 que no están modeladas.**
- **Documento:** pág. 6. Los umbrales para quien inicia actividades (sus dos primeros meses) y el límite de ingresos atribuidos a la Provincia en Convenio Multilateral. Además, la errata «$5.226.00» del tramo 6.
- **Propuesta:** exigir el hecho declarado «no inició actividades en el ejercicio» y no modelar el límite de Convenio Multilateral.
- **Falta acreditar:** tu conformidad con esa simplificación.
- **Bloqueado:** nada adicional. Igual ninguna regla se guarda como sugerencia de la norma, porque todas son condicionadas.

### Santa Cruz

**S1. El Anexo I oficial encontrado es un antecedente de 2021.**
- **Documento:** BO de Santa Cruz N° 5615 del 25/11/2021 (archivo PDF del BO), Ley 3760, art. 7°: «REEMPLÁZASE los Anexos I y II de la Ley 3485». El Anexo I tiene 957 códigos («código AFIP», 5 dígitos).
- **Diferencias con tu «ALICUTAS 2026.pdf» (creado el 12/10/2021):** 465 de 956 códigos comunes tienen otra tasa.

  | Tu PDF → BO | Códigos | Ejemplo |
  |---|---|---|
  | 2,00 % → 1,50 % | 251 | 101011 «Matanza de ganado bovino» |
  | 1,50 % → 0,75 % | 91 | 11111 «Cultivo de arroz» (BO, pág. 2) |
  | 3,00 % → 2,00 % | 26 | 491110 «Servicio de transporte ferroviario urbano y suburbano de pasajeros» |
  | 3,00 % → 2,50 % | 24 | 410011 «Construcción, reforma y reparación de edificios residenciales» |
  | 6,50 % → 5,00 % | 18 | 461011 «Venta al por mayor en comisión o consignación de cereales…» |
  | 5,00 % → 4,00 % | 13 | 602100 «Emisión y retransmisión de televisión abierta» |
  | 6,00 % → 5,00 % | 13 | 681010 «Servicios de alquiler y explotación de inmuebles para fiestas…» |

  Están sólo en tu PDF 463181, 466400 y 471121 (3,00 %). Está sólo en el BO 162100 (1,50 %).
- **Propuesta:** tratar el Anexo I de la Ley 3760 como antecedente de 2021 y tu PDF como versión anterior no vigente. No usar ninguno de los dos como tasa.
- **Falta acreditar:**
  - la vigencia de la Ley 3760, que no tiene artículo propio y depende del Código Fiscal (Ley 3486);
  - modificaciones del Anexo I entre 2022 y 2026; el BO en línea es parcial y ASIP respondía 503;
  - el adicional para contribuyentes con sede fuera de la provincia;
  - cómo representar los códigos de 5 dígitos.
- **Bloqueado:** toda sugerencia de Santa Cruz. La carga manual sigue disponible.

### Corrientes y NAES

**R1. Corrientes, RG DGR 293/2025** (nomenclador provincial con alícuotas y mínimos desde 2026, según fuentes secundarias).
- **Intentos:**
  - el sitio de la DGR: en las RG 2025 de la categoría 301 hallé las RG 279, 280 y 281/2025, pero no la 293;
  - el buscador de la DGR requiere JavaScript;
  - el subdominio `dgr04e` tiene un certificado inválido, y no lo forcé.
- **Falta acreditar:** el texto oficial y su publicación.
- **Bloqueado:** toda sugerencia de Corrientes. La Ley 6249 (alícuotas por descripción) queda como antecedente.

**R2. NAES, normas posteriores.**
- **Fuentes alternativas:** Infoleg y el BO listan las RG CA 3 a 9/2026. Las Disposiciones de Presidencia ratificadas (1, 5, 8 y 9/2026) tratan de vencimientos, contingencias de los sistemas SIFERE y SIRTAC, y el padrón federal; ninguna se refiere al NAES. Las RG 12 a 15/2026 responden HTTP 500.
- **Falta acreditar:** Disposiciones no ratificadas por RG, normas posteriores al 19/10/2026 y el texto del ordenamiento electrónico de la RG 3/2026.
- **Bloqueado:** nada adicional. El catálogo NAES espera tu revisión de vigencia.

## 1. NAES: `naes-rg-ca-19-2025`

### Técnico (preparador: sin diferencias)
La planilla XLSX oficial y el texto del anexo I en PDF de la RG CA 19/2025 coinciden: 1013 códigos en el mismo orden, sin códigos de más, con descripciones e «Inicio/Fin de Vigencia» idénticos. El log está en `cotejos/naes-vs-anexo-I-pdf.log`.

### Vigencia: altas y bajas con su referencia exacta

| Códigos | Movimiento | Norma | Ubicación |
|---|---|---|---|
| 530091, 530099, 631111, 631112, 631119, 631121, 631122, 631123, 631129, 631203, 631204, 649291, 649292, 649299, 649992, 661993, 661994, 731002 (18) | **Altas**, «Inicio de Vigencia: 01/2026» | RG CA 12/2025, **art. 1°** («Incorporar en el Anexo I… las siguientes actividades económicas»); aplicación desde el 01/01/2026 (**art. 6°**) | RG 12/2025, págs. 2 a 9 (530091 y 530099 en la 2; 631111 a 631119 en la 3; 631121 a 631129 en la 4; 631203 y 631204 en la 5; 649291 y 649292 en la 6; 649299, 649992, 661993 y 661994 en la 7; 731002 en la 9). RG 19/2025, anexo I, págs. 164 a 192 |
| 530090 → 530099, 631110 → 631119, 631120 → 631129, 649290 → 649299 | **Bajas**, «Fin de Vigencia: 12/2025» | RG CA 12/2025, **art. 3°** («quedarán sustituidos por la nueva codificación»). El **art. 4°** fija el trámite de modificación entre el 1° y el 31/01/2026 y el reempadronamiento de oficio | RG 12/2025, págs. 11 y 12. RG 19/2025, anexo I, págs. 164 (530090), 175 (631110 y 631120) y 180 (649290) |
| Los 995 restantes | Vigentes desde 01/2018 | RG CA 7/2017 y modificatorias, ordenadas por la RG CA 19/2025 (**art. 1°**, anexos I y II) | RG 19/2025, anexo I |

- El **art. 2°** de la RG 12/2025 modifica las columnas «incluye/excluye» de 016120, 016130, 016149 y 463154. Esas columnas **no se importaron**: la descripción no cambia.
- **Normas posteriores.** Revisé las RG CA 2026 número 1, 2 y 4 a 11 (PDF del sitio de la CA) y ninguna se refiere al NAES. La **RG CA 3/2026**, que antes estaba pendiente, quedó **resuelta** con el [BO del 02/03/2026](https://www.boletinoficial.gob.ar/detalleAviso/primera/338936/20260302): aprueba el «Ordenamiento Jurídico de las Normas de la Comisión Arbitral» de edición electrónica, deroga la RG 1/2005 y no menciona el NAES.
- **Segunda búsqueda (27/10, reanudación):** las RG CA 12 a 15/2026 responden HTTP 500 en el sitio de la CA (pueden no existir). En el BO no encontré Disposiciones de Presidencia de 2026 que modifiquen el NAES, aunque la búsqueda no es exhaustiva. Tampoco localicé el texto del NAES dentro del ordenamiento electrónico de la RG CA 3/2026.
- **Coincidencia independiente:** la Res. AGIP 365/2025 de CABA (copia de la carpeta del estudio) incorpora exactamente las mismas 18 altas y sustituye los mismos 4 códigos.
- **Incertidumbre que queda, concreta:**
  - normas de la CA posteriores al 19/10/2026 o no publicadas en su sitio;
  - Disposiciones de Presidencia no indexadas;
  - un eventual texto del NAES distinto en el ordenamiento electrónico de la RG 3/2026.

**Decisión pedida:** `technical` y `validity`.

## 2. ARCA / CLAE: `clae-rg-afip-3537-2013`

### Técnico (preparador: con diferencias explicadas)
- **Contra el nomenclador en línea de ARCA** ([serviciosweb.afip.gob.ar/genericos/nomencladoractividades](https://serviciosweb.afip.gob.ar/genericos/nomencladoractividades/index.aspx), consultado y guardado el 27/10/2026): mismos 951 códigos. **950 descripciones coinciden.** La diferencia es 492150, por un artefacto de la propia página («pasajeros, e1203excepto…»); el anexo PDF dice «pasajeros, excepto…». La página suma 7 códigos 0000xx de la tabla anexa, que no son actividades. El log está en `cotejos/clae-vs-nomenclador-web-arca.log`.
- **Contra la columna «Descripción ARCA» del anexo II de la RG CA 19/2025** (transcripción de **otro** organismo): 941 iguales y 10 distintas. El log está en `cotejos/clae-vs-anexo-II-comarb.log`.

Las discrepancias sustantivas (de significado, no de tipeo):

| Código | Anexo RG 3537 (ARCA, PDF del 18/11/2013) **= importado** | Nomenclador web de ARCA (27/10/2026) | Anexo II, RG CA 19/2025 (CA, 10/12/2025) |
|---|---|---|---|
| 014440 | Cría de ganado caprino realizada en cabañas | Igual que el anexo | … en cabañas **y para la producción de leche** |
| 110412 | Fabricación de sodas | Igual que el anexo | Fabricación de sodas **y aguas** |
| 110420 | Elaboración de bebidas gaseosas, excepto soda | Igual que el anexo | … excepto **sodas y aguas** |
| 466110 | Venta al por mayor de combustibles y lubricantes para automotores | Igual que el anexo | … de combustibles **n.c.p.** y lubricantes … |
| 951200 | Reparación y mantenimiento de equipos de telefonía y de comunicación | Igual que el anexo | … de equipos **de comunicación** |
| 011129 | Cultivo de cereales de uso forrajero n.c.p. | Igual que el anexo | «Cultivo de maíz». Es un error evidente de la CA: su propio anexo I describe así el 011129 del NAES |

Diferencias de forma: 099000 («natual», *sic*, igual en el PDF y en la web de ARCA), 492150 («E1203» en la CA), 552000 («"camping"» frente a «campings») y 949930 (tipeo de la CA).

- **Resultado:** ARCA mantiene, en su nomenclador vigente y en el anexo normativo, el texto importado. **No sustituí ninguna descripción.** Las variantes de la CA no tienen respaldo en una fuente de ARCA, así que no hace falta retener códigos del autocompletado.
- **Si preferís** retener esos 5 códigos hasta tener una tercera confirmación, se puede hacer sin cambiar nada más.
- **Antes** había clasificado 4 discrepancias como sustantivas. **014440** también lo es: son 5. Quedan todas resueltas por la evidencia de ARCA.

### Vigencia
- RG AFIP 3537/2013: sancionada el 30/10/2013, BO del 01/11/2013, aplicable desde el 01/11/2013 (**art. 2°**). La Biblioteca de ARCA la marca «Vigente».
- La RG 5607/2024 (966 actividades) fue **abrogada** por la RG 5612/2024, **art. 1°** (BO del 10/12/2024).
- El nomenclador en línea muestra las mismas 951 actividades.

**Decisión pedida:** `technical` y `validity`.

## 3. Alícuotas CABA 2026: `caba-ley-6927-2026`

### Técnico (preparador: sin diferencias)
- Las 848 filas de las Planillas 1 a 11 tienen exactamente las tasas de sus artículos (1277 celdas).
- Todos los códigos están vigentes en el NAES 2026.
- Las planillas del anexo original y del corregido son idénticas; sólo cambia la paginación.

### Texto normativo y efecto propuesto

Páginas del PDF del anexo con fe de erratas (`fuentes/caba/L6927-FEERR-ANX.pdf`) y de la Ley 6948 (`fuentes/caba/L6948-ley.pdf`).

| Norma, artículo y página | Texto (extracto literal) | Efecto propuesto | Estado |
|---|---|---|---|
| Ley 6927, art. 2°, pág. 1 | «Las disposiciones de la presente Ley entran en vigencia a partir del 1º de enero de 2026» | El conjunto rige del 01/01 al 31/12/2026 | Propuesto |
| Anexo, art. 1°, pág. 1 | «alícuota del 0,00% para las actividades de Producción Primaria… especificadas en la "PLANILLA ADJUNTA DE ACTIVIDADES 1"… siempre que no se trate de actividades que… tengan previsto otro tratamiento» | 0 % **explícito** (no exento) para 114 códigos, con el hecho declarado «sin otro tratamiento» | Propuesto |
| Anexo, art. 2°, pág. 1 | «alícuota del 1,00% para las actividades de Producción y Elaboración de Bienes… no alcanzan a los ingresos obtenidos por las ventas efectuadas a los Estados… Tampoco… a consumidores finales… La venta de bienes muebles destinados… como "bienes de uso" tributa bajo el régimen general… no alcanza a las actividades hidrocarburíferas» | 1 % con cuatro hechos declarados: sin otro tratamiento, no ventas a Estados ni a consumidores finales, actividad industrial no hidrocarburífera, no bienes de uso | Propuesto |
| Anexo, art. 3°, pág. 1 | «ingresos brutos anuales en el ejercicio fiscal anterior iguales o inferiores a pesos dos mil cuatro millones ($ 2.004.000.000)… 3,00%… superiores… 3,75%» | Dos tramos del 01/01 al 31/05/2026 | Propuesto |
| Anexo, art. 3°, último párrafo, pág. 1 | «Los ingresos… de Electricidad, Gas y Agua, exceptuando los correspondientes al inciso 20 del artículo 19 y al artículo 58, y cuyo destinatario sea el consumidor residencial tributarán a la alícuota del 4,00%» | 4 % residencial | **RETENIDA.** El inc. 20 del art. 19 (pág. 10) es «Distribución… de gas licuado de petróleo en garrafas», que es coherente. Pero el **art. 58 del Anexo (pág. 24) trata de coeficientes por zona de carteles publicitarios**, así que la remisión parece errónea o se refiere a otra norma |
| Anexo, art. 4°, pág. 2 | «alícuota del 2,00% para las actividades de la Construcción» | 2 % | Propuesto |
| Anexo, arts. 5° y 6°, pág. 2; art. 8°, pág. 2; arts. 9° a 11, pág. 3 | Umbral de $364.000.000 en el art. 5° (3 % / 5 %); en los demás, $2.004.000.000: art. 6° (3 % / 4,5 %), art. 8° (3 % / 4 %), art. 9° (3 % / 5 %), art. 10 (3 % / 4,75 %), art. 11 (3 % / 5 %) | Dos tramos del 01/01 al 31/05/2026 | Propuesto |
| Anexo, art. 7°, pág. 2 | «alícuota del 2,00% para… Transporte» | 2 % | Propuesto |
| Anexo, art. 22, pág. 15 | «debe considerarse el articulado, posteriormente los incisos y por último las actividades económicas» | Los 39 códigos de planillas citados en los arts. 12 a 21 y 26 quedan **sin tasa automática** | Propuesto (conservador) |
| Planilla 2 (pág. 47) y Planilla 5 (pág. 51); Planilla 8 (pág. 67) y Planilla 11 (pág. 74) | 301200, 302000 y 303000 figuran en las Planillas 2 y 5; 639100 y 639900, en las 8 y 11 | **Sin tasa automática** (encuadre ambiguo) | Propuesto |
| Ley 6948, arts. 1° a 7°, págs. 1 a 3 | «…iguales o inferiores a pesos dos mil ciento cincuenta y cuatro millones trescientos mil ($2.154.300.000)…» y, en el art. 5°, «…trescientos noventa y un millones ciento veintiocho mil ($391.128.000)…»; mismas tasas | Nuevos umbrales para los arts. 3°, 5°, 6° y 8° a 11 | **RETENIDAS** (14 reglas) |
| Ley 6948, art. 9°, pág. 4 | «Se dispone la adecuación de las PLANILLAS ADJUNTAS DE ACTIVIDADES Nros. 3, 5, 6, 8, 9, 10 y 11… de conformidad con las modificaciones establecidas en los artículos precedentes» | Se propone mantener los códigos de cada planilla de la Ley 6927 y cambiar sólo los umbrales | **Interpretación pendiente** |
| Ley 6948, art. 10, pág. 4 | «Las disposiciones de la presente Ley entran en vigencia a partir del primer día hábil del mes siguiente al de su publicación» (BOCBA 7369, 19/05/2026) | Desde el lunes **01/06/2026** | **Interpretación pendiente** |

**Garantías vigentes:**
- **«Sin otro tratamiento» nunca se presume.** Cada regla lo exige como hecho declarado; el panel lo muestra «Sin indicar» y no preselecciona nada.
- **Nada condicionado se guarda como «sugerencia de la norma».**
  - Todas las reglas de CABA tienen condiciones (como mínimo, «sin otro tratamiento»). El servidor no puede acreditarlas al guardar, porque los hechos declarados y los ingresos no se guardan, así que rechaza guardarlas como `CONFIRMED_SUGGESTION`.
  - El panel sólo ofrece «Registrar como decisión del estudio» (`STUDIO_MANUAL`, sin `ruleRef`), con una constancia que nunca viene marcada.
  - «Confirmar sugerencia de la norma» existe sólo para una respuesta única sin condiciones. Hoy ninguna regla cargada lo es.
- **Control del servidor.** Rechaza reglas de conjuntos no aprobados, reglas retenidas, reglas condicionadas, y reglas cuya inscripción exigida no coincide con la de la ficha (también si sólo cambia la inscripción).
- **Por las retenciones,** desde el 01/06/2026 CABA responde «Alícuota pendiente de determinar» para todos los códigos de las Planillas 3, 5, 6 y 8 a 11. Entre enero y mayo, la Planilla 3 nunca da una respuesta única.

**Decisiones pedidas:**
- `technical`, `validity` e `interpretation`;
- las dos interpretaciones de la Ley 6948 (arts. 9° y 10);
- la remisión al art. 58 del art. 3°;
- si querés modelar los arts. 12 a 21.

## 4. Provincia de Buenos Aires (ARBA): `arba-naiibb18-2026-10-27` y `arba-ley-15558-2026`

**Fuente:** la exportación oficial descargada de arba.gov.ar el 27/10/2026. Tu copia de julio de 2025 no se usa porque fue re-guardada y perdió ceros iniciales y el formato de fechas.

**Técnico (preparador).**
- Lectura como texto tabulado ISO-8859-1, con coma decimal y códigos y fechas sin conversión.
- Catálogo: 1035 códigos.
- Tramos 2026: los 1022 códigos con alícuota coinciden con la tabla del art. 20 de la Ley 15.558 en las 8 columnas (general y tramos 1 a 7), y los topes son los del art. 20, incisos a) a g).
- Diferencias de la exportación: 32 filas duplicadas del último tramo, descartadas.

**Vigencia.**
- NAIIB-18: RN 38/2017, art. 4° (desde el 1° anticipo de 2018), y RN 34/2025, art. 12° (desde el 01/01/2026).
- Ley 15.558: BO PBA del 15/12/2025. El conjunto cubre sólo 2026.
- No verifiqué modificaciones posteriores de ninguna de las dos.
- Errata del BO: el umbral de inicio de actividades del tramo 6 figura «$5.226.00».

**Interpretación (decisiones pedidas).**
- [ ] **Hechos que el estudio declara:** sin exención, y no haber iniciado actividades en el ejercicio. Los umbrales de los dos primeros meses no están modelados.
- [ ] **Inscripción:** las reglas se limitan a LOCAL y CONVENIO_MULTILATERAL, sin Régimen Simplificado.
- [ ] **No modelado:** el límite de ingresos atribuidos a la Provincia en Convenio Multilateral (último párrafo del art. 20).
- [ ] **222 códigos retenidos:**
  - `bonif_actiba = S` o `AlicuotaSUS`: campos de la exportación sin definición normativa verificada;
  - tratamientos especiales: art. 22 (390000 y 812090, servicios a municipios, 1,5 %) y art. 134 (631201 a 631204, art. 184 bis del Código Fiscal, 2 %).
- [ ] **Mismo código, distinto significado:** NAIIB-18 ≠ NAES. Por ejemplo, 731002 en ARBA es «Servicios de publicidad, por actividades de intermediación», y en el NAES, publicidad de creadores de contenido (ARBA lo codifica 731003). Nada se equipara por código.

## 5. Santa Cruz: sigue sin reglas

- **ASIP:** respondió 503 en todos los reintentos.
- **Encontrado en el BO provincial (archivo en PDF):** el **BO 5615 del 25/11/2021** trae la **Ley 3760**. Su art. 7° reemplaza los Anexos I y II de la Ley 3485. El Anexo I tiene 957 códigos con alícuota y usa «códigos AFIP» de 5 dígitos, sin el cero inicial.
- **Tu «ALICUTAS 2026.pdf» (creado el 12/10/2021) NO coincide con ese Anexo I:**
  - de 956 códigos comunes, 465 tienen otra tasa, casi siempre más alta (en 251 códigos dice 2,00 % donde el BO dice 1,50 %, y en 91 dice 1,50 % donde el BO dice 0,75 %);
  - 3 códigos están sólo en tu PDF (463181, 466400 y 471121) y 1 sólo en el BO (162100);
  - probablemente es una versión anterior a la Ley 3760. Ni su nombre ni sus metadatos prueban vigencia, y **no se usa**.
- **Posterior a 2021 (BO en línea):**
  - Ley 3863 y Res. ASIP 38/2025: modifican sólo el Anexo II (tasas administrativas);
  - Res. ASIP 96/2025 y 7/2026: importes fijos del Régimen Simplificado (cuotas fijas, otra categoría);
  - Res. ASIP 194/2025: vencimientos de 2026.
  - No encontré modificaciones del Anexo I, aunque la búsqueda no es exhaustiva.
- **Por qué no hay reglas:**
  - la vigencia de la Ley 3760 depende del Código Fiscal, que no verifiqué;
  - no puedo descartar modificaciones posteriores del Anexo I;
  - falta decidir cómo representar sus códigos de 5 dígitos;
  - el adicional para contribuyentes con sede fuera de la provincia no está verificado en el texto vigente.
- **Cobertura:** pendiente. La carga manual sigue disponible.

## 6. Corrientes: sólo antecedentes

- **Ley 6249 (tarifaria):** tu copia «modif 09032021» es idéntica byte a byte al PDF oficial de la DGR. Fija la alícuota general en 2,90 % (art. 3°) y alícuotas especiales **por descripción de actividad**, no por código. No genero reglas: habría que encuadrar cada código a mano.
- **Código Fiscal (2019) y Decreto 130/2025:** el código es antecedente; el decreto es el **calendario de vencimientos 2026**, en una copia de un sitio de normativa, no del BO.
- **Pendiente de fuente oficial:**
  - la RG DGR 293/2025, que según fuentes secundarias aprueba un nomenclador NAES provincial con alícuotas y mínimos desde 2026. No la encontré en el sitio de la DGR, y no forcé una dirección con certificado inválido;
  - un fallo de la Corte Suprema (abril de 2026) sobre el último párrafo del art. 6° de la Ley 6249, sin verificar.

## 7. Alícuota del cálculo actual: flujo de alta y primera liquidación (sin cambios en el motor)

Flujo verificado en el código:

| Paso | Qué pasa | Dónde |
|---|---|---|
| 1. Alta del cliente | El campo muestra 3 «predeterminado, pendiente de confirmación». Si no se cambia, el formulario **no envía** `defaultIibbRate`; si se cambia, lo envía | `client-profile-form.tsx` (`legacyChanged`) |
| 2. Validación del alta | Sin el campo, la API asigna **3**; con el campo, lo valida con `parseRate` | `lib/api-input.ts` (`LEGACY_INITIAL_IIBB_RATE`); la columna además tiene `@default(3.000000)` en `prisma/schema.prisma` |
| 3. Guardado | `Client.defaultIibbRate = 3.000000`. La ficha IIBB (actividades, alícuotas por jurisdicción) se guarda aparte y **no** modifica ese valor | `app/api/clients/route.ts` |
| 4. Primera liquidación | IIBB = base de ventas × `Client.defaultIibbRate` (si fuera nulo, 3), con **una sola** alícuota para todo el cliente: no usa jurisdicciones, actividades ni la ficha nueva | `lib/liquidation-calc.ts` |
| 5. Presentación | «Impuesto Determinado (3%)» y, junto a él, la aclaración de que es la alícuota única del cálculo actual, que no viene de las actividades ni es una liquidación por jurisdicción (pantalla y columna C del Excel) | `liquidation/page.tsx`, `lib/excel.ts`, `LIQUIDATION_RATE_NOTE` |

**Riesgo residual:** nada en el dato distingue «valor inicial» de «valor confirmado», por eso todos los clientes existentes dicen «Sin constancia de revisión». La página `/settings` muestra una «Alícuota Predeterminada IIBB» que no se guarda: es anterior a este bloque y no la modifiqué.

**Decisión aplicada (27/10):** edición dentro de la ficha, sin pantalla separada.
- **Rótulo:** «Alícuota del cálculo actual (%)», con la aclaración de alcance: el cálculo y las exportaciones usan este único valor, que no viene de las actividades ni representa una liquidación por jurisdicción.
- **Estado:**
  - en el alta, «3 %: valor predeterminado, pendiente de confirmación»;
  - en clientes existentes, «Sin constancia de revisión», el mismo para todos y sin deducirlo del valor.
- **Envío:** sólo si cambió.
- **Liquidación y Excel:** aclaración junto a la alícuota, sólo texto.
- **Sin migración** y sin cambiar valores existentes.
