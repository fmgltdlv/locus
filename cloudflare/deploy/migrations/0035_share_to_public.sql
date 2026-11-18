ALTER TABLE organizations ADD COLUMN share_to_public INTEGER NOT NULL DEFAULT 0;
ALTER TABLE organizations ADD COLUMN public_identity_mode TEXT NOT NULL DEFAULT 'named';
