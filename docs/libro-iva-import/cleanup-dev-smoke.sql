-- Limpieza del cliente sintético del smoke del Libro IVA Digital.
--
-- SÓLO DEV (proyecto esyfpakajthdifhnhcew). NO ejecutar sin autorización explícita.
-- Es UN SOLO bloque DO: cualquier RAISE EXCEPTION revierte TODO lo hecho en el
-- bloque (también los DELETE ya ejecutados). No hay COMMIT parcial posible.
--
-- Acotado por: id del cliente + nombre exacto + organización.
-- La pertenencia de los comprobantes se prueba por "Period" ("Invoice"."clientId"
-- es nullable en el esquema real); además se exige que ningún comprobante del
-- cliente tenga un clientId u organización distintos.
--
-- Esquema verificado en DEV el 04/11/2026 (pg_constraint):
--   Period            -> Client   RESTRICT  (se borra explícitamente)
--   Invoice           -> Period   RESTRICT  (se borra explícitamente; 2 FK)
--   TaxRecord         -> Period   RESTRICT  (se borra explícitamente)
--   PeriodVatSettings -> Period   CASCADE   (se borra explícitamente, igual se cuenta)
--   InvoiceVatLine    -> Invoice  CASCADE   (cae con el comprobante; se cuenta)
--   ClientActivity    -> Client   CASCADE   (se cuenta)
--   ClientJurisdiction-> Client   CASCADE   (se cuenta)
--   MembershipClient  -> Client   CASCADE   (migración 12 del PR #28; verificado en DEV
--                                  el 04/11/2026, tras sus pruebas). Se borra explícitamente
--                                  SÓLO la fila del acceso de prueba sobre este
--                                  cliente; la Membership se CONSERVA.
--   Ninguna FK apunta a InvoiceVatLine. AuditLog no tiene FK a estas tablas:
--   se CONSERVA y se verifica que su total no cambie.
--
-- Modo de prueba: con dry_run = true hace todo, verifica todo y al final
-- aborta a propósito (nada queda borrado). Para borrar de verdad: false.

DO $$
DECLARE
    dry_run      constant boolean := true;

    c_id         constant text := 'cmw1kqvuy0001jq09pc7luasa';
    c_name       constant text := 'CLIENTE SINTETICO LID SMOKE';
    c_org        constant text := 'cmts8llsg0000vg437y8tzjna';

    -- Conteos esperados (DEV, 04/11/2026, al cerrar el ensayo de recuperación).
    exp_periods      constant bigint := 4;
    exp_invoices     constant bigint := 60064;
    exp_vat_lines    constant bigint := 80076;
    exp_tax_records  constant bigint := 0;
    exp_vat_settings constant bigint := 0;
    exp_activities   constant bigint := 0;
    exp_jurisdictions constant bigint := 0;
    -- Acceso de prueba del PR #28 (DISABLED) con alcance sobre este cliente.
    exp_mc_membership constant text := 'cmw2idvvf0001jp095rxar1rb';
    exp_membership_clients constant bigint := 1;

    n bigint;
    audit_before bigint;
    audit_after  bigint;
    memb_before  bigint;
    memb_after   bigint;
BEGIN
    -- Bloquea al cliente (y falla si no es exactamente el esperado).
    PERFORM 1 FROM "Client" WHERE id = c_id AND name = c_name AND "organizationId" = c_org FOR UPDATE;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN RAISE EXCEPTION 'identidad: se esperaba 1 cliente (id, nombre, organización) y hay %', n; END IF;

    SELECT count(*) INTO n FROM "Client" WHERE name = c_name;
    IF n <> 1 THEN RAISE EXCEPTION 'identidad: el nombre % no es único (% clientes)', c_name, n; END IF;

    -- Períodos del cliente, todos de la misma organización.
    SELECT count(*) INTO n FROM "Period" WHERE "clientId" = c_id;
    IF n <> exp_periods THEN RAISE EXCEPTION 'períodos: esperado %, hay %', exp_periods, n; END IF;
    SELECT count(*) INTO n FROM "Period" WHERE "clientId" = c_id AND "organizationId" <> c_org;
    IF n <> 0 THEN RAISE EXCEPTION 'períodos de otra organización: %', n; END IF;
    PERFORM 1 FROM "Period" WHERE "clientId" = c_id FOR UPDATE;

    -- Comprobantes: pertenencia por Period; clientId y organización coherentes.
    SELECT count(*) INTO n FROM "Invoice" i JOIN "Period" p ON p.id = i."periodId" WHERE p."clientId" = c_id;
    IF n <> exp_invoices THEN RAISE EXCEPTION 'comprobantes: esperado %, hay %', exp_invoices, n; END IF;
    SELECT count(*) INTO n FROM "Invoice" i JOIN "Period" p ON p.id = i."periodId"
     WHERE p."clientId" = c_id AND (i."clientId" IS DISTINCT FROM c_id OR i."organizationId" <> c_org);
    IF n <> 0 THEN RAISE EXCEPTION 'comprobantes con clientId u organización distintos: %', n; END IF;
    SELECT count(*) INTO n FROM "Invoice" i
     WHERE i."clientId" = c_id AND NOT EXISTS (SELECT 1 FROM "Period" p WHERE p.id = i."periodId" AND p."clientId" = c_id);
    IF n <> 0 THEN RAISE EXCEPTION 'comprobantes con este clientId en períodos ajenos: %', n; END IF;

    -- Dependencias.
    SELECT count(*) INTO n FROM "InvoiceVatLine" l JOIN "Invoice" i ON i.id = l."invoiceId" JOIN "Period" p ON p.id = i."periodId" WHERE p."clientId" = c_id;
    IF n <> exp_vat_lines THEN RAISE EXCEPTION 'líneas de IVA: esperado %, hay %', exp_vat_lines, n; END IF;
    SELECT count(*) INTO n FROM "TaxRecord" t JOIN "Period" p ON p.id = t."periodId" WHERE p."clientId" = c_id;
    IF n <> exp_tax_records THEN RAISE EXCEPTION 'TaxRecord: esperado %, hay %', exp_tax_records, n; END IF;
    SELECT count(*) INTO n FROM "PeriodVatSettings" s JOIN "Period" p ON p.id = s."periodId" WHERE p."clientId" = c_id;
    IF n <> exp_vat_settings THEN RAISE EXCEPTION 'PeriodVatSettings: esperado %, hay %', exp_vat_settings, n; END IF;
    SELECT count(*) INTO n FROM "ClientActivity" WHERE "clientId" = c_id;
    IF n <> exp_activities THEN RAISE EXCEPTION 'ClientActivity: esperado %, hay %', exp_activities, n; END IF;
    SELECT count(*) INTO n FROM "ClientJurisdiction" WHERE "clientId" = c_id;
    IF n <> exp_jurisdictions THEN RAISE EXCEPTION 'ClientJurisdiction: esperado %, hay %', exp_jurisdictions, n; END IF;
    SELECT count(*) INTO n FROM "MembershipClient" WHERE "clientId" = c_id;
    IF n <> exp_membership_clients THEN RAISE EXCEPTION 'MembershipClient: esperado %, hay %', exp_membership_clients, n; END IF;
    SELECT count(*) INTO n FROM "MembershipClient"
     WHERE "clientId" = c_id AND ("membershipId" <> exp_mc_membership OR "organizationId" <> c_org);
    IF n <> 0 THEN RAISE EXCEPTION 'MembershipClient: hay % filas de otro acceso u organización', n; END IF;

    -- Ninguna FK nueva hacia estas tablas que el bloque no contemple.
    SELECT count(*) INTO n FROM pg_constraint c
     WHERE c.contype = 'f'
       AND c.confrelid IN ('"Client"'::regclass, '"Period"'::regclass, '"Invoice"'::regclass, '"InvoiceVatLine"'::regclass)
       AND c.conname NOT IN (
           'ClientActivity_clientId_organizationId_fkey', 'ClientJurisdiction_clientId_organizationId_fkey',
           'Period_clientId_organizationId_fkey', 'InvoiceVatLine_invoiceId_organizationId_fkey',
           'MembershipClient_clientId_organizationId_fkey',
           'Invoice_periodId_clientId_organizationId_fkey', 'Invoice_periodId_organizationId_fkey',
           'PeriodVatSettings_periodId_organizationId_fkey', 'TaxRecord_periodId_organizationId_fkey');
    IF n <> 0 THEN RAISE EXCEPTION 'esquema: hay % FK no revisadas hacia Client/Period/Invoice/InvoiceVatLine', n; END IF;

    SELECT count(*) INTO audit_before FROM "AuditLog";
    SELECT count(*) INTO memb_before FROM "Membership";

    -- Borrado, verificando cada conteo.
    DELETE FROM "Invoice" i USING "Period" p
     WHERE i."periodId" = p.id AND p."clientId" = c_id AND p."organizationId" = c_org AND i."organizationId" = c_org;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> exp_invoices THEN RAISE EXCEPTION 'DELETE Invoice: esperado %, borró %', exp_invoices, n; END IF;

    DELETE FROM "TaxRecord" t USING "Period" p
     WHERE t."periodId" = p.id AND p."clientId" = c_id AND p."organizationId" = c_org;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> exp_tax_records THEN RAISE EXCEPTION 'DELETE TaxRecord: esperado %, borró %', exp_tax_records, n; END IF;

    DELETE FROM "PeriodVatSettings" s USING "Period" p
     WHERE s."periodId" = p.id AND p."clientId" = c_id AND p."organizationId" = c_org;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> exp_vat_settings THEN RAISE EXCEPTION 'DELETE PeriodVatSettings: esperado %, borró %', exp_vat_settings, n; END IF;

    DELETE FROM "Period" WHERE "clientId" = c_id AND "organizationId" = c_org;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> exp_periods THEN RAISE EXCEPTION 'DELETE Period: esperado %, borró %', exp_periods, n; END IF;

    DELETE FROM "MembershipClient"
     WHERE "clientId" = c_id AND "organizationId" = c_org AND "membershipId" = exp_mc_membership;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> exp_membership_clients THEN RAISE EXCEPTION 'DELETE MembershipClient: esperado %, borró %', exp_membership_clients, n; END IF;

    DELETE FROM "Client" WHERE id = c_id AND name = c_name AND "organizationId" = c_org;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN RAISE EXCEPTION 'DELETE Client: esperado 1, borró %', n; END IF;

    -- Verificación final.
    SELECT count(*) INTO n FROM "Invoice" WHERE "clientId" = c_id;
    IF n <> 0 THEN RAISE EXCEPTION 'quedan % comprobantes con este clientId', n; END IF;
    SELECT count(*) INTO n FROM "InvoiceVatLine" l WHERE NOT EXISTS (SELECT 1 FROM "Invoice" i WHERE i.id = l."invoiceId");
    IF n <> 0 THEN RAISE EXCEPTION 'quedan % líneas de IVA huérfanas', n; END IF;
    SELECT count(*) INTO n FROM "MembershipClient" WHERE "clientId" = c_id;
    IF n <> 0 THEN RAISE EXCEPTION 'quedan % filas de MembershipClient del cliente', n; END IF;
    SELECT count(*) INTO memb_after FROM "Membership";
    IF memb_after <> memb_before THEN RAISE EXCEPTION 'Membership cambió: % -> %', memb_before, memb_after; END IF;
    SELECT count(*) INTO audit_after FROM "AuditLog";
    IF audit_after <> audit_before THEN RAISE EXCEPTION 'AuditLog cambió: % -> %', audit_before, audit_after; END IF;

    IF dry_run THEN
        RAISE EXCEPTION 'DRY RUN OK (revertido): cliente 1, períodos %, comprobantes %, líneas de IVA % (cascada), MembershipClient %, AuditLog % y Membership % sin cambios',
            exp_periods, exp_invoices, exp_vat_lines, exp_membership_clients, audit_after, memb_after;
    END IF;
    RAISE NOTICE 'Limpieza aplicada: cliente 1, períodos %, comprobantes %, líneas de IVA %, MembershipClient %; AuditLog % y Membership % conservados',
        exp_periods, exp_invoices, exp_vat_lines, exp_membership_clients, audit_after, memb_after;
END
$$;
