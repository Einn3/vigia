-- 0003: respetar check_interval_s por monitor.
-- El scheduler solo encola los monitores vencidos y marca last_checked_at
-- al encolar. NULL = nunca revisado = vencido.
-- Aplicada en remoto 2026-11-09 vía la API de D1 (wrangler d1 execute
-- también la aplicaría: `wrangler d1 execute vigia-db --remote
-- --file=migrations/0003_add_last_checked_at.sql`).
ALTER TABLE monitors ADD COLUMN last_checked_at INTEGER;
