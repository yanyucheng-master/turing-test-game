ALTER TABLE `culture_candidates`
  MODIFY COLUMN `status`
    ENUM(
      'candidate',
      'pending_ai_review',
      'pending_review',
      'active',
      'rejected',
      'expired'
    )
    NOT NULL DEFAULT 'candidate',
  ADD COLUMN `approved_fingerprint` VARCHAR(64) NULL,
  ADD COLUMN `origin` ENUM('learned', 'curated') NULL,
  ADD COLUMN `review_payload` TEXT NULL,
  ADD COLUMN `ai_reviewed_at` TIMESTAMP NULL,
  ADD COLUMN `human_reviewed_at` TIMESTAMP NULL,
  ADD COLUMN `rejection_reason` VARCHAR(32) NULL;

-- Old automatically promoted memories must pass the new AI + owner gate.
UPDATE `culture_candidates`
SET
  `status` = 'pending_ai_review',
  `approved_fingerprint` = NULL,
  `origin` = NULL,
  `opener_eligible` = FALSE,
  `promoted_at` = NULL,
  `review_payload` = NULL,
  `ai_reviewed_at` = NULL,
  `human_reviewed_at` = NULL,
  `rejection_reason` = NULL,
  `expires_at` = DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 30 DAY)
WHERE `status` = 'active';
