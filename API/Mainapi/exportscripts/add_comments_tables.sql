-- Script pour créer les tables de commentaires, likes et notifications dans MySQL
-- Généré le 2025-01-27
-- À importer dans phpMyAdmin

-- Table des commentaires principaux
CREATE TABLE IF NOT EXISTS comments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    content_type VARCHAR(50) NOT NULL,
    content_id VARCHAR(255) NOT NULL,
    user_id VARCHAR(255) NOT NULL,
    user_type VARCHAR(50) NOT NULL,
    profile_id VARCHAR(255),
    username VARCHAR(255) NOT NULL,
    avatar TEXT,
    content TEXT NOT NULL,
    is_spoiler TINYINT(1) DEFAULT 0,
    is_vip TINYINT(1) DEFAULT 0,
    is_admin TINYINT(1) DEFAULT 0,
    is_edited TINYINT(1) DEFAULT 0,
    created_at BIGINT NOT NULL,
    updated_at BIGINT,
    deleted TINYINT(1) DEFAULT 0,
    INDEX idx_comments_content (content_type, content_id),
    INDEX idx_comments_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table des réponses aux commentaires
CREATE TABLE IF NOT EXISTS comment_replies (
    id INT AUTO_INCREMENT PRIMARY KEY,
    comment_id INT NOT NULL,
    parent_reply_id INT,
    user_id VARCHAR(255) NOT NULL,
    user_type VARCHAR(50) NOT NULL,
    profile_id VARCHAR(255),
    username VARCHAR(255) NOT NULL,
    avatar TEXT,
    reply_to_username VARCHAR(255),
    content TEXT NOT NULL,
    is_spoiler TINYINT(1) DEFAULT 0,
    is_vip TINYINT(1) DEFAULT 0,
    is_admin TINYINT(1) DEFAULT 0,
    is_edited TINYINT(1) DEFAULT 0,
    created_at BIGINT NOT NULL,
    updated_at BIGINT,
    deleted TINYINT(1) DEFAULT 0,
    hierarchical_path VARCHAR(255),
    INDEX idx_replies_comment (comment_id),
    INDEX idx_replies_user (user_id),
    INDEX idx_replies_hierarchical_path (comment_id, hierarchical_path),
    FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_reply_id) REFERENCES comment_replies(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table des réactions (cœurs)
CREATE TABLE IF NOT EXISTS comment_reactions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    target_type VARCHAR(50) NOT NULL,
    target_id INT NOT NULL,
    user_id VARCHAR(255) NOT NULL,
    user_type VARCHAR(50) NOT NULL,
    profile_id VARCHAR(255),
    created_at BIGINT NOT NULL,
    UNIQUE KEY unique_reaction (target_type, target_id, user_id, user_type, profile_id),
    INDEX idx_reactions_target (target_type, target_id),
    INDEX idx_reactions_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table des notifications
CREATE TABLE IF NOT EXISTS notifications (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    user_type VARCHAR(50) NOT NULL,
    profile_id VARCHAR(255),
    from_user_id VARCHAR(255) NOT NULL,
    from_profile_id VARCHAR(255),
    from_username VARCHAR(255) NOT NULL,
    from_avatar TEXT,
    notification_type VARCHAR(50) NOT NULL,
    target_type VARCHAR(50) NOT NULL,
    target_id INT NOT NULL,
    content_type VARCHAR(50) NOT NULL,
    content_id VARCHAR(255) NOT NULL,
    comment_preview TEXT,
    is_read TINYINT(1) DEFAULT 0,
    created_at BIGINT NOT NULL,
    INDEX idx_notifications_user (user_id, is_read),
    INDEX idx_notifications_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table des likes/dislikes pour les films et séries
CREATE TABLE IF NOT EXISTS likes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    content_type VARCHAR(50) NOT NULL,
    content_id VARCHAR(255) NOT NULL,
    user_id VARCHAR(255) NOT NULL,
    user_type VARCHAR(50) NOT NULL,
    profile_id VARCHAR(255),
    vote_type VARCHAR(20) NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT,
    UNIQUE KEY unique_like (content_type, content_id, user_id, user_type, profile_id),
    INDEX idx_likes_content (content_type, content_id),
    INDEX idx_likes_user (user_id, user_type, profile_id),
    INDEX idx_likes_content_vote (content_type, content_id, vote_type),
    INDEX idx_likes_stats (content_type, content_id, vote_type, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Commentaires sur les tables
ALTER TABLE comments COMMENT = 'Table des commentaires principaux';
ALTER TABLE comment_replies COMMENT = 'Table des réponses aux commentaires avec hiérarchie';
ALTER TABLE comment_reactions COMMENT = 'Table des réactions (cœurs) sur commentaires et réponses';
ALTER TABLE notifications COMMENT = 'Table des notifications utilisateur';
ALTER TABLE likes COMMENT = 'Table des likes/dislikes pour films et séries';

-- Vérification de la création
SELECT 'Tables créées avec succès' as Status;
SHOW TABLES LIKE '%comment%';
SHOW TABLES LIKE '%notification%';
SHOW TABLES LIKE '%like%';

