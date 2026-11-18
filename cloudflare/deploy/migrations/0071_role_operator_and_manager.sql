-- Rename legacy org/global role "user" to "operator".
UPDATE users SET role = 'operator' WHERE role = 'user';
UPDATE user_organizations SET role = 'operator' WHERE role = 'user';
UPDATE org_signup_allowlist SET role = 'operator' WHERE role = 'user';
