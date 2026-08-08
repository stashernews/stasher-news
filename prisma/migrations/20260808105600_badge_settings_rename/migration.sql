-- Rebrand the badge privacy + notification settings (cowboy-era names).
ALTER TABLE users RENAME COLUMN "hideCowboyHat" TO "hideBadges";
ALTER TABLE users RENAME COLUMN "noteCowboyHat" TO "noteBadges";
