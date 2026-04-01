-- Link Submissions table
-- Allows authenticated users to propose streaming links for movies/episodes/seasons
-- Links must be approved by staff (admin/uploader) before being added to films/series tables

CREATE TABLE IF NOT EXISTS link_submissions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    profile_id VARCHAR(255) NOT NULL,
    tmdb_id INT NOT NULL,
    media_type ENUM('movie', 'tv') NOT NULL,
    season_number INT DEFAULT NULL,
    episode_number INT DEFAULT NULL,
    url VARCHAR(2048) NOT NULL,
    source_name VARCHAR(100) DEFAULT NULL COMMENT 'Optional label for the source (e.g. SeekStreaming, VidMoly, etc.)',
    status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
    rejection_reason TEXT DEFAULT NULL,
    reviewed_by VARCHAR(255) DEFAULT NULL,
    reviewed_at DATETIME DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_status (status),
    INDEX idx_profile (profile_id),
    INDEX idx_tmdb (tmdb_id, media_type),
    INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
