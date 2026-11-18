-- Registro degli accessi non modificabile, storico delle modifiche, dati clinici mai cancellati.
-- Migrazione scritta a mano (drizzle-kit generate --custom): lo schema Drizzle non esprime trigger.

-- 1. Rifiuto generico di una modifica, con il motivo in chiaro.
CREATE FUNCTION mmg_forbid(reason text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%', reason USING ERRCODE = 'insufficient_privilege';
END $$;
--> statement-breakpoint
CREATE FUNCTION mmg_forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM mmg_forbid(TG_ARGV[0]);
  RETURN NULL;
END $$;
--> statement-breakpoint

-- 2. Impronta di una riga del registro: la stessa funzione serve al trigger e alla verifica.
CREATE FUNCTION mmg_access_log_hash(prev text, r access_log) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to(concat_ws('|',
    prev,
    r.seq::text,
    to_char(r.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    coalesce(r.studio_id::text, ''),
    coalesce(r.user_id::text, ''),
    coalesce(r.patient_id::text, ''),
    r.action,
    r.outcome,
    coalesce(r.workstation, ''),
    r.details::text
  ), 'UTF8')), 'hex')
$$;
--> statement-breakpoint

-- 3. Ogni riga nuova prende il numero successivo e l'impronta della precedente.
--    Il blocco consultivo serializza gli inserimenti: la catena non ha buchi né rami.
CREATE FUNCTION mmg_access_log_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  last_seq bigint;
  last_hash text;
BEGIN
  PERFORM pg_advisory_xact_lock(4620119);
  SELECT seq, hash INTO last_seq, last_hash FROM access_log ORDER BY seq DESC LIMIT 1;
  NEW.seq := coalesce(last_seq, 0) + 1;
  NEW.prev_hash := coalesce(last_hash, '');
  NEW.hash := mmg_access_log_hash(NEW.prev_hash, NEW);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER access_log_chain BEFORE INSERT ON access_log
  FOR EACH ROW EXECUTE FUNCTION mmg_access_log_chain();
--> statement-breakpoint
CREATE TRIGGER access_log_immutable BEFORE UPDATE OR DELETE ON access_log
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('Il registro degli accessi non si modifica e non si cancella');
--> statement-breakpoint
CREATE TRIGGER access_log_no_truncate BEFORE TRUNCATE ON access_log
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('Il registro degli accessi non si svuota');
--> statement-breakpoint

-- 4. Verifica della catena: restituisce il primo numero in cui la catena è rotta, o NULL.
--    Rileva righe modificate (impronta diversa) e righe tolte (buco nella numerazione).
CREATE FUNCTION mmg_access_log_verify() RETURNS bigint
LANGUAGE plpgsql STABLE AS $$
DECLARE
  r access_log;
  expected_seq bigint := 1;
  prev text := '';
BEGIN
  FOR r IN SELECT * FROM access_log ORDER BY seq LOOP
    IF r.seq <> expected_seq OR r.prev_hash <> prev OR r.hash <> mmg_access_log_hash(prev, r) THEN
      RETURN expected_seq;
    END IF;
    prev := r.hash;
    expected_seq := expected_seq + 1;
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint

-- 5. Storico delle modifiche: non modificabile.
CREATE TRIGGER change_history_immutable BEFORE UPDATE OR DELETE ON change_history
  FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change('Lo storico delle modifiche non si modifica e non si cancella');
--> statement-breakpoint
CREATE TRIGGER change_history_no_truncate BEFORE TRUNCATE ON change_history
  FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change('Lo storico delle modifiche non si svuota');
--> statement-breakpoint

-- 6. Chi ha fatto la modifica: l'applicazione lo dichiara a ogni transazione con
--    set_config('app.user_id', …, true). Il trigger lo copia nello storico.
CREATE FUNCTION mmg_record_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  new_row jsonb := to_jsonb(NEW);
BEGIN
  INSERT INTO change_history (user_id, table_name, row_id, operation, old_row, new_row)
  VALUES (
    nullif(current_setting('app.user_id', true), '')::uuid,
    TG_TABLE_NAME,
    coalesce(new_row ->> 'id', new_row ->> 'entry_id'),
    TG_OP,
    CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END,
    new_row
  );
  RETURN NULL;
END $$;
--> statement-breakpoint

-- 7. Dati dei pazienti: storico di ogni modifica, nessuna cancellazione.
--    «I dati clinici non si cancellano mai: si annullano con motivo, e lo storico resta.»
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'family', 'patient', 'patient_choice', 'exemption', 'consent', 'delegation',
    'clinical_entry', 'problem_detail', 'diary_detail', 'measurement_detail', 'anamnesis_detail',
    'allergy_detail', 'risk_factor_detail', 'examination_detail', 'vaccination_detail',
    'lab_result_detail', 'report_detail', 'attachment', 'therapeutic_plan', 'therapy',
    'appointment', 'patient_request'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION mmg_record_change()',
      t || '_history', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION mmg_forbid_change(%L)',
      t || '_no_delete', t, 'I dati dei pazienti non si cancellano: si annullano con un motivo');
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION mmg_forbid_change(%L)',
      t || '_no_truncate', t, 'I dati dei pazienti non si cancellano');
  END LOOP;
END $$;
