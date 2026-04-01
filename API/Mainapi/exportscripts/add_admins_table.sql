-- Script pour ajouter la table admins à la base de données MySQL
-- Généré le 2025-01-27

-- Table des administrateurs
CREATE TABLE IF NOT EXISTS admins (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL UNIQUE,
    auth_type ENUM('oauth', 'bip-39') NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_user_id (user_id),
    INDEX idx_auth_type (auth_type)
);

-- Commentaires sur la table
ALTER TABLE admins COMMENT = 'Table des administrateurs avec types d\'authentification';



-- Vérification de la création
SELECT 'Table admins créée avec succès' as Status;
DESCRIBE admins;
