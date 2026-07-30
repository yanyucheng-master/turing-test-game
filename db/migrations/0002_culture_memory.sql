CREATE TABLE IF NOT EXISTS `culture_candidates` (
  `fingerprint` VARCHAR(64) NOT NULL,
  `status` ENUM('candidate', 'active', 'expired') NOT NULL DEFAULT 'candidate',
  `phrase` VARCHAR(96) NULL,
  `response_mode` ENUM('play_along', 'react_only', 'clarify_light')
    NOT NULL DEFAULT 'play_along',
  `support_count` INT NOT NULL DEFAULT 0,
  `opener_eligible` BOOLEAN NOT NULL DEFAULT FALSE,
  `use_count` INT NOT NULL DEFAULT 0,
  `first_seen_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_seen_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expires_at` TIMESTAMP NOT NULL,
  `promoted_at` TIMESTAMP NULL,
  PRIMARY KEY (`fingerprint`),
  INDEX `culture_candidates_status_expires_idx` (`status`, `expires_at`)
);

CREATE TABLE IF NOT EXISTS `culture_observations` (
  `id` VARCHAR(64) NOT NULL,
  `fingerprint` VARCHAR(64) NOT NULL,
  `source_fingerprint` VARCHAR(64) NOT NULL,
  `kind` ENUM('phrase', 'reaction') NOT NULL,
  `response_mode` ENUM('play_along', 'react_only', 'clarify_light') NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `culture_observations_fingerprint_kind_idx` (`fingerprint`, `kind`)
);
