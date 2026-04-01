-- Script pour ajouter les colonnes de modération aux tables de commentaires
-- Généré le 2025-01-04
-- À importer dans phpMyAdmin

-- Ajouter les colonnes de modération à la table comments
ALTER TABLE comments
    ADD COLUMN moderation_reason VARCHAR(50) DEFAULT NULL COMMENT 'INSULTES, EROTIQUE, DEMANDE_AJOUT',
    ADD COLUMN moderation_details TEXT DEFAULT NULL COMMENT 'Détails de la modération par Gemini',
    ADD COLUMN moderated_at BIGINT DEFAULT NULL COMMENT 'Timestamp de la modération',
    ADD COLUMN approved_by_admin TINYINT(1) DEFAULT 0 COMMENT 'Si approuvé par un admin après modération',
    ADD COLUMN approved_at BIGINT DEFAULT NULL COMMENT 'Timestamp de l\'approbation admin';

-- Ajouter les colonnes de modération à la table comment_replies
ALTER TABLE comment_replies
    ADD COLUMN moderation_reason VARCHAR(50) DEFAULT NULL COMMENT 'INSULTES, EROTIQUE, DEMANDE_AJOUT',
    ADD COLUMN moderation_details TEXT DEFAULT NULL COMMENT 'Détails de la modération par Gemini',
    ADD COLUMN moderated_at BIGINT DEFAULT NULL COMMENT 'Timestamp de la modération',
    ADD COLUMN approved_by_admin TINYINT(1) DEFAULT 0 COMMENT 'Si approuvé par un admin après modération',
    ADD COLUMN approved_at BIGINT DEFAULT NULL COMMENT 'Timestamp de l\'approbation admin';

-- Index pour faciliter les requêtes de modération
CREATE INDEX idx_comments_moderation ON comments (deleted, moderation_reason);
CREATE INDEX idx_replies_moderation ON comment_replies (deleted, moderation_reason);
