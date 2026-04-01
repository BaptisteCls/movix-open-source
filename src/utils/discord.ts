import { DISCORD_CONFIG } from '../config/discord';

// Cache object to store Discord API responses
const discordCache = {
  userRoles: new Map<string, { roles: string[], timestamp: number, isAdmin: boolean }>(),
  userInfo: new Map<string, { user: any, timestamp: number }>()
};

/**
 * Check if a user is a member of the Discord guild and has required roles
 */
export async function checkDiscordMembership(accessToken: string) {
  try {
    // Check if we have cached roles for this token
    const cachedRoles = discordCache.userRoles.get(accessToken);
    const now = Date.now();
    
    // If cached data exists and is still valid
    if (cachedRoles && (now - cachedRoles.timestamp) < (DISCORD_CONFIG.CACHE_DURATION * 1000)) {
      console.log('Using cached Discord roles data');
      return {
        isMember: true,
        roles: cachedRoles.roles,
        isAdmin: cachedRoles.isAdmin
      };
    }
    
    // Check for rate limit data in localStorage to avoid excessive API calls
    const rateLimit = getRateLimitInfo();
    if (rateLimit.isRateLimited) {
      console.log('API rate limited, using stored data if available');
      
      // Use data from localStorage if available
      const storedUserData = localStorage.getItem('discord_user');
      if (storedUserData) {
        try {
          const userData = JSON.parse(storedUserData);
          const roles = userData.roles || [];
          const isAdmin = userData.isAdmin || false;
          
          // Save to cache to avoid future checks during rate limit
          discordCache.userRoles.set(accessToken, { 
            roles, 
            isAdmin,
            timestamp: now 
          });
          
          return {
            isMember: true,
            roles,
            isAdmin
          };
        } catch (error) {
          console.error('Error parsing stored user data:', error);
        }
      }
    }
    
    // Do not call Discord API from client. Use locally stored data instead.
    console.log('Using local stored Discord roles data (no external call)');
    const storedUserData = localStorage.getItem('discord_user');
    let roles: string[] = [];
    let isAdmin = false;
    if (storedUserData) {
      try {
        const userData = JSON.parse(storedUserData);
        roles = Array.isArray(userData.roles) ? userData.roles : [];
        isAdmin = typeof userData.isAdmin === 'boolean' ? userData.isAdmin : hasAdminRole(roles);
      } catch (e) {
        console.error('Error parsing stored user data:', e);
      }
    }
    // Cache the result
    discordCache.userRoles.set(accessToken, {
      roles,
      isAdmin,
      timestamp: now
    });
    return {
      isMember: roles.length > 0 || !!storedUserData,
      roles,
      isAdmin
    };
  } catch (error) {
    console.error('Erreur lors de la vérification Discord:', error);
    
    // If there was an error but we have cached data in localStorage, use it
    const storedUserData = localStorage.getItem('discord_user');
    if (storedUserData) {
      try {
        const userData = JSON.parse(storedUserData);
        const roles = userData.roles || [];
        const isAdmin = userData.isAdmin || false;
        
        return {
          isMember: true,
          roles,
          isAdmin
        };
      } catch (parseError) {
        console.error('Error parsing stored user data after API error:', parseError);
      }
    }
    
    return {
      isMember: false,
      roles: [],
      isAdmin: false
    };
  }
}

/**
 * Check if a user has any of the admin roles
 */
export function hasAdminRole(roles: string[]): boolean {
  if (!roles || !Array.isArray(roles) || roles.length === 0) {
    return false;
  }
  
  // Check if the user has any of the admin roles
  return DISCORD_CONFIG.ADMIN_ROLE_IDS.some(roleId => roles.includes(roleId));
}

/**
 * Get detailed user information from Discord
 */
export async function getDiscordUserInfo(accessToken: string) {
  try {
    // Check if we have cached user info
    const cachedInfo = discordCache.userInfo.get(accessToken);
    const now = Date.now();
    
    // If cached data exists and is still valid
    if (cachedInfo && (now - cachedInfo.timestamp) < (DISCORD_CONFIG.CACHE_DURATION * 1000)) {
      console.log('Using cached Discord user info');
      return cachedInfo.user;
    }
    
    // Check for rate limit
    const rateLimit = getRateLimitInfo();
    if (rateLimit.isRateLimited) {
      console.log('API rate limited for user info, using stored data if available');
      
      // Use data from localStorage if available
      const storedUserData = localStorage.getItem('discord_user');
      if (storedUserData) {
        try {
          const userData = JSON.parse(storedUserData);
          if (userData.id && userData.username) {
            return userData;
          }
        } catch (error) {
          console.error('Error parsing stored user data:', error);
        }
      }
    }
    
    // Fetch fresh data from Discord API
    console.log('Fetching fresh Discord user info');
    const userResponse = await fetch(`${DISCORD_CONFIG.API_ENDPOINT}/users/@me`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    // Check for rate limit
    if (userResponse.status === 429) {
      // We're rate limited, store info and use existing data if available
      const resetAfter = parseInt(userResponse.headers.get('X-RateLimit-Reset-After') || '40');
      setRateLimitInfo(true, resetAfter);
      
      console.log(`Rate limited for user info, reset after ${resetAfter} seconds`);
      
      // Try to use data from localStorage
      const storedUserData = localStorage.getItem('discord_user');
      if (storedUserData) {
        try {
          return JSON.parse(storedUserData);
        } catch (error) {
          console.error('Error parsing stored user data during rate limit:', error);
          throw error;
        }
      }
      
      throw new Error('Rate limited and no cached data available');
    }

    if (!userResponse.ok) {
      throw new Error('Erreur lors de la récupération des informations utilisateur');
    }

    // Clear rate limit since we got a successful response
    setRateLimitInfo(false, 0);

    const userData = await userResponse.json();
    
    // Cache the result
    discordCache.userInfo.set(accessToken, { 
      user: userData, 
      timestamp: now 
    });
    
    return userData;
  } catch (error) {
    console.error('Erreur lors de la récupération des informations utilisateur:', error);
    
    // If there was an error but we have cached data in localStorage, use it
    const storedUserData = localStorage.getItem('discord_user');
    if (storedUserData) {
      try {
        return JSON.parse(storedUserData);
      } catch (parseError) {
        console.error('Error parsing stored user data after API error:', parseError);
      }
    }
    
    throw error;
  }
}

/**
 * Get rate limit information from localStorage
 */
function getRateLimitInfo() {
  try {
    const rateLimitData = localStorage.getItem('discord_rate_limit');
    if (rateLimitData) {
      const data = JSON.parse(rateLimitData);
      const now = Date.now();
      const isStillLimited = now < data.resetTime;
      
      if (!isStillLimited) {
        // Clear rate limit info if it's expired
        localStorage.removeItem('discord_rate_limit');
        return { isRateLimited: false, resetTime: 0 };
      }
      
      return data;
    }
  } catch (error) {
    console.error('Error getting rate limit info:', error);
  }
  
  return { isRateLimited: false, resetTime: 0 };
}

/**
 * Set rate limit information in localStorage
 */
function setRateLimitInfo(isRateLimited: boolean, resetAfterSeconds: number) {
  try {
    if (isRateLimited) {
      const resetTime = Date.now() + (resetAfterSeconds * 1000);
      localStorage.setItem('discord_rate_limit', JSON.stringify({
        isRateLimited,
        resetTime
      }));
    } else {
      localStorage.removeItem('discord_rate_limit');
    }
  } catch (error) {
    console.error('Error setting rate limit info:', error);
  }
} 