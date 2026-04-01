// Rivestream Secret Key Generator
// Based on rivestreal.js logic

const C_ARRAY = [
  "4Z7lUo", "gwIVSMD", "PLmz2elE2v", "Z4OFV0", "SZ6RZq6Zc", "zhJEFYxrz8",
  "FOm7b0", "axHS3q4KDq", "o9zuXQ", "4Aebt", "wgjjWwKKx", "rY4VIxqSN",
  "kfjbnSo", "2DyrFA1M", "YUixDM9B", "JQvgEj0", "mcuFx6JIek", "eoTKe26gL",
  "qaI9EVO1rB", "0xl33btZL", "1fszuAU", "a7jnHzst6P", "wQuJkX", "cBNhTJlEOf",
  "KNcFWhDvgT", "XipDGjST", "PCZJlbHoyt", "2AYnMZkqd", "HIpJh", "KH0C3iztrG",
  "W81hjts92", "rJhAT", "NON7LKoMQ", "NMdY3nsKzI", "t4En5v", "Qq5cOQ9H",
  "Y9nwrp", "VX5FYVfsf", "cE5SJG", "x1vj1", "HegbLe", "zJ3nmt4OA",
  "gt7rxW57dq", "clIE9b", "jyJ9g", "B5jXjMCSx", "cOzZBZTV", "FTXGy",
  "Dfh1q1", "ny9jqZ2POI", "X2NnMn", "MBtoyD", "qz4Ilys7wB", "68lbOMye",
  "3YUJnmxp", "1fv5Imona", "PlfvvXD7mA", "ZarKfHCaPR", "owORnX", "dQP1YU",
  "dVdkx", "qgiK0E", "cx9wQ", "5F9bGa", "7UjkKrp", "Yvhrj",
  "wYXez5Dg3", "pG4GMU", "MwMAu", "rFRD5wlM"
];

/**
 * Première fonction de hachage
 */
const hash1 = (input: string): string => {
  let t = 0;
  for (let n = 0; n < input.length; n++) {
    const r = input.charCodeAt(n);
    t = (r + (t << 6) + (t << 16) - t) >>> 0;
    const i = ((t << (n % 5)) | (t >>> (32 - (n % 5)))) >>> 0;
    t ^= (i ^ ((r << (n % 7)) | (r >>> (8 - (n % 7))))) >>> 0;
    t = (t + ((t >>> 11) ^ (t << 3))) >>> 0;
  }
  t ^= t >>> 15;
  t = Math.imul(t, 49842) >>> 0;
  t ^= t >>> 13;
  t = Math.imul(t, 40503) >>> 0;
  t ^= t >>> 16;
  return t.toString(16).padStart(8, "0");
};

/**
 * Deuxième fonction de hachage
 */
const hash2 = (input: string): string => {
  const t = String(input);
  let n = (3735928559 ^ t.length) >>> 0;
  for (let e = 0; e < t.length; e++) {
    let r = t.charCodeAt(e);
    r ^= ((131 * e + 89) ^ (r << (e % 5))) & 255;
    n = ((n << 7) | (n >>> 25)) >>> 0 ^ r;
    n = Math.imul(n, 60205) >>> 0;
    n ^= n >>> 11;
  }
  n ^= n >>> 15;
  n = Math.imul(n, 49842) >>> 0;
  n ^= n >>> 13;
  n = Math.imul(n, 40503) >>> 0;
  n ^= n >>> 16;
  n = Math.imul(n, 10196) >>> 0;
  n ^= n >>> 15;
  return n.toString(16).padStart(8, "0");
};

/**
 * Génère un secret key pour l'API Rivestream basé sur l'ID TMDB
 * @param tmdbId - L'ID TMDB (movie ou TV show)
 * @returns Le secret key encodé en Base64
 */
export const generateRivestreamSecretKey = (tmdbId: string): string => {
  try {
    const r = String(tmdbId);
    let t: string;
    let n: number;

    if (isNaN(Number(tmdbId))) {
      // Logique pour les IDs non-numériques
      const e = r.split("").reduce((e, t) => e + t.charCodeAt(0), 0);
      t = C_ARRAY[e % C_ARRAY.length] || btoa(r);
      n = Math.floor((e % r.length) / 2);
    } else {
      // Logique pour les IDs numériques
      const i = Number(tmdbId);
      t = C_ARRAY[i % C_ARRAY.length] || btoa(r);
      n = Math.floor((i % r.length) / 2);
    }

    // Étape 1: Création de la chaîne intermédiaire
    const intermediateString = r.slice(0, n) + t + r.slice(n);
    
    // Étape 2: Premier hachage
    const h1_result = hash1(intermediateString);
    
    // Étape 3: Second hachage
    const h2_result = hash2(h1_result);
    
    // Étape 4: Encodage final en Base64
    const secretKey = btoa(h2_result);
    
    console.log(`🔑 Generated Rivestream secretKey for ID ${tmdbId}: ${secretKey} (hex: ${h2_result})`);
    return secretKey;
  } catch (e) {
    console.error("Erreur lors de la génération de la clé Rivestream:", e);
    return 'MDFkNTQ1NmE='; // Fallback vers une clé statique
  }
};

