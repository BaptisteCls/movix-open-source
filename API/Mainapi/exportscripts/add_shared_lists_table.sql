-- Script pour créer la table shared_lists dans MySQL
-- À importer dans phpMyAdmin

CREATE TABLE IF NOT EXISTS shared_lists (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    user_type VARCHAR(50) NOT NULL,
    profile_id VARCHAR(255) NOT NULL,
    list_id VARCHAR(255) NOT NULL,
    share_code VARCHAR(20) NOT NULL,
    is_public_in_catalog TINYINT(1) NOT NULL DEFAULT 0,
    moderation_flagged TINYINT(1) NOT NULL DEFAULT 0,
    moderation_reason VARCHAR(255),
    moderation_details TEXT,
    moderated_at BIGINT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    UNIQUE KEY uq_share_code (share_code),
    UNIQUE KEY uq_user_list (user_id, user_type, profile_id, list_id),
    INDEX idx_shared_lists_share_code (share_code),
    INDEX idx_shared_lists_user_profile (user_id, user_type, profile_id),
    INDEX idx_shared_lists_moderation (moderation_flagged, is_public_in_catalog)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
