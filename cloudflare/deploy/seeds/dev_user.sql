-- Local Miniflare D1 only (`npm run d1:migrate:local` then `npm run d1:seed:dev`).
-- NEVER run against remote/production D1.
-- Login: dev@example.com / dev   (username "dev" also works on the login form)
-- Safe to run multiple times (skips if dev@example.com already exists).

PRAGMA foreign_keys = ON;

INSERT INTO organizations (name, subscription_tier)
SELECT 'Local Dev', 'basic'
WHERE NOT EXISTS (SELECT 1 FROM organizations WHERE name = 'Local Dev');

INSERT INTO users (
  username,
  email,
  password_hash,
  role,
  organization_id,
  default_organization_id
)
SELECT
  'dev',
  'dev@example.com',
  '$2a$10$.3EN6d5X80z4WQa/PRy0deFUkgQUcPCLrHFJdTv1sBQSeQe9M5e52',
  'dev',
  (SELECT id FROM organizations WHERE name = 'Local Dev' LIMIT 1),
  (SELECT id FROM organizations WHERE name = 'Local Dev' LIMIT 1)
WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = 'dev@example.com');

INSERT INTO user_organizations (user_id, organization_id, role)
SELECT u.id, o.id, 'admin'
FROM users u
CROSS JOIN organizations o
WHERE u.email = 'dev@example.com'
  AND o.name = 'Local Dev'
  AND NOT EXISTS (
    SELECT 1
    FROM user_organizations uo
    WHERE uo.user_id = u.id
      AND uo.organization_id = o.id
  );
