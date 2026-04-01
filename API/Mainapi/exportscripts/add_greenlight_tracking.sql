-- Script pour ajouter le tracking admin aux changements de statut wishboard
-- Permet de savoir quel admin/uploader a greenlight une demande

-- Ajouter les colonnes admin_id et admin_auth_type a wishboard_status_history
ALTER TABLE wishboard_status_history
    ADD COLUMN admin_id VARCHAR(255) DEFAULT NULL COMMENT 'ID de l admin qui a change le statut',
    ADD COLUMN admin_auth_type VARCHAR(10) DEFAULT NULL COMMENT 'Type auth de l admin (oauth ou bip-39)';

-- Index pour faciliter les requetes de leaderboard
CREATE INDEX idx_wsh_admin_status ON wishboard_status_history (admin_id, status);

-- Verification
SELECT 'Colonnes admin_id et admin_auth_type ajoutees a wishboard_status_history' as Status;
DESCRIBE wishboard_status_history;
