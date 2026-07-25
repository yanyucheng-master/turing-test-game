-- Expand games.status for cancel/abandon lifecycle.
-- Safe to re-run on MySQL 8+ only if values are missing; prefer drizzle-kit push in preview.

ALTER TABLE `games`
  MODIFY COLUMN `status` ENUM('active', 'finished', 'cancelled', 'abandoned')
  NOT NULL DEFAULT 'active';
