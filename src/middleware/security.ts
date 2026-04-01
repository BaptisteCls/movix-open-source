import { NextApiRequest, NextApiResponse } from 'next';

export function securityMiddleware(req: NextApiRequest, res: NextApiResponse, next: () => void) {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://api.themoviedb.org; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' https://image.tmdb.org data:; " +
    "connect-src 'self' https://api.themoviedb.org https://frembed.bond https://discord.com;"
  );

  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Permissions-Policy', 
    'geolocation=(), microphone=(), camera=(), payment=()'
  );

  res.setHeader('Access-Control-Allow-Origin', 'https://streammovix.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  next();
} 