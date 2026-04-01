const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * Encodes bytes to Base62 using the specified alphabet
 * @param e - Array of bytes to encode
 * @returns Base62 encoded string
 */
function encodeBytesToBase62(e: Uint8Array): string {
  let t = BigInt(0);
  for (const s of e)
    t = (t << BigInt(8)) + BigInt(s);
  const n = BigInt(ALPHABET.length);
  let r = "";
  if (t === BigInt(0)) return ALPHABET[0]; // return "0" for zero
  for (; t > 0; )
    r = ALPHABET[Number(t % n)] + r,
    t /= n;
  return r;
}

/**
 * Decodes a Base62 string back to bytes
 * @param e - Base62 encoded string
 * @returns Uint8Array of decoded bytes
 */
function decodeBase62ToBytes(e: string): Uint8Array {
  const n = BigInt(ALPHABET.length);
  let t = BigInt(0);
  
  for (const s of e) {
    const i = ALPHABET.indexOf(s);
    if (i === -1) {
      throw new Error(`Invalid character in base62 string: ${s}`);
    }
    t = t * n + BigInt(i);
  }
  
  const r: number[] = [];
  for (; t > 0; )
    r.unshift(Number(t & BigInt(0xFF))),
    t >>= BigInt(8);
  
  return new Uint8Array(r);
}

/**
 * Generates a random string of specified length using the Base62 alphabet
 * @param length - Length of the random string
 * @returns Random string
 */
function generateRandomString(length: number): string {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += ALPHABET.charAt(Math.floor(Math.random() * ALPHABET.length));
  }
  return result;
}

/**
 * Encodes a TMDB ID using Base62 with a random suffix
 * @param tmdbId - The TMDB ID to encode
 * @returns Encoded string with format: [base62_id][random_suffix]
 */
export function encodeId(tmdbId: string | number): string {
  const id = String(tmdbId);
  
  // Convert ID string to bytes
  const encoder = new TextEncoder();
  const bytes = encoder.encode(id);
  
  // Encode to Base62
  const base62Id = encodeBytesToBase62(bytes);
  
  // Generate random suffix (30 characters to match example length)
  const randomSuffix = generateRandomString(30);
  
  // Combine Base62 ID with random suffix
  return base62Id + randomSuffix;
}

/**
 * Decodes an encoded ID to get the original TMDB ID
 * @param encodedId - The encoded ID string
 * @returns Original TMDB ID or null if invalid
 */
export function decodeId(encodedId: string): string | null {
  try {
    // Check if it's legacy base64 format
    if (isLegacyBase64Id(encodedId)) {
      // Legacy format: remove last 7 characters and decode base64
      const base64Part = encodedId.slice(0, -7);
      const originalId = atob(base64Part);
      
      // Validate that it's a valid number
      if (!/^\d+$/.test(originalId)) {
        return null;
      }
      
      return originalId;
    }
    
    // New base62 format: try to decode directly by removing suffix
    // We expect a random suffix of ~30 chars, try prefixes up to that
    const MAX_SUFFIX = 30;
    const start = Math.max(1, encodedId.length - MAX_SUFFIX);
    
    for (let i = start; i >= 1; i--) {
      try {
        const base62Part = encodedId.slice(0, i);
        
        // Decode from Base62 to bytes
        const bytes = decodeBase62ToBytes(base62Part);
        
        // Convert bytes back to string
        const decoder = new TextDecoder();
        const originalId = decoder.decode(bytes);
        
        // Validate that it's a valid number
        if (/^\d+$/.test(originalId)) {
          return originalId;
        }
      } catch (error) {
        // Continue trying shorter base62 parts
        continue;
      }
    }
    
    return null;
  } catch (error) {
    console.error('Error decoding ID:', error);
    return null;
  }
}

/**
 * Checks if a string is a legacy base64 encoded ID
 * @param id - The ID string to check
 * @returns True if it appears to be a legacy base64 encoded ID
 */
function isLegacyBase64Id(id: string): boolean {
  // Base64 contains '=' for padding, base62 doesn't
  return id.includes('=');
}

/**
 * Checks if a string is an encoded ID (has the expected format)
 * @param id - The ID string to check
 * @returns True if it appears to be an encoded ID
 */
export function isEncodedId(id: string): boolean {
  // If it's purely numeric, it's not "encoded" — treat as plain TMDB id
  if (/^\d+$/.test(id)) {
    return false;
  }

  // Check for legacy base64 format first
  if (isLegacyBase64Id(id)) {
    return true;
  }
  
  // For base62 format, check if all characters are in the alphabet
  for (const char of id) {
    if (ALPHABET.indexOf(char) === -1) {
      return false;
    }
  }
  
  return true;
}

/**
 * Gets the TMDB ID from either encoded or plain format
 * @param id - Either encoded or plain TMDB ID
 * @returns The plain TMDB ID
 */
export function getTmdbId(id: string): string | null {
  // If it's already a plain numeric ID, return it immediately.
  if (/^\d+$/.test(id)) {
    return id;
  }

  // Otherwise, if it appears encoded, try to decode it
  if (isEncodedId(id)) {
    return decodeId(id);
  }
  
  return null;
}
