const mysql = require('mysql2/promise');
require('dotenv').config();

// Configuration de la connexion MySQL — credentials from environment variables
const dbConfig = {
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 20,       // 20 × 6 workers = 120 connexions max (avant: 300 × 2 pools × 6 = 3600)
  maxIdle: 5,                // Libère les connexions inactives au-delà de 5
  idleTimeout: 60000,        // Ferme les connexions idle après 60s
  queueLimit: 200,           // Limite la file d'attente en mémoire (avant: illimité)
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000
};

// Pool de connexions MySQL partagé — single instance per worker
let pool = null;
let poolInitializing = false;

// Initialiser le pool (async, with connection test)
const initPool = async () => {
  if (pool) return pool;
  if (poolInitializing) {
    // Prevent double-creation race: wait for existing init
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (pool) { clearInterval(check); resolve(pool); }
      }, 50);
    });
  }
  poolInitializing = true;
  try {
    pool = mysql.createPool(dbConfig);
    console.log('✅ MySQL connection pool created successfully');

    // Test de connexion
    const connection = await pool.getConnection();
    console.log('✅ MySQL connection test successful');
    connection.release();
  } catch (error) {
    console.error('❌ MySQL connection error:', error.message);
  } finally {
    poolInitializing = false;
  }
  return pool;
};

// Getter pour le pool (initialise si nécessaire — uses existing pool if already created)
const getPool = () => {
  if (!pool) {
    console.warn('⚠️ MySQL pool not initialized yet, initializing synchronously...');
    pool = mysql.createPool(dbConfig);
  }
  return pool;
};

module.exports = {
  initPool,
  getPool,
  dbConfig
};

