-- Monitores de ejemplo (bórralos o cámbialos por los tuyos).
-- Se aplican con: npx wrangler d1 execute vigia-db --file migrations/0002_seed.sql
INSERT INTO monitors (id, name, url, check_interval_s, keyword, expected_status, created_at)
VALUES
  ('example-com', 'Example.com', 'https://example.com', 60, NULL, 200, unixepoch() * 1000),
  ('cloudflare-com', 'Cloudflare', 'https://www.cloudflare.com', 60, NULL, 200, unixepoch() * 1000)
ON CONFLICT(id) DO NOTHING;
