const express = require('express');

const { requireVip } = require('../checkVip');

const router = express.Router();

router.get('/debrid/bestdebrid-key', requireVip, (req, res) => {
  const apiKey = (process.env.BESTDEBRID_API_KEY || '').trim();

  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');

  if (!apiKey) {
    return res.status(503).json({
      success: false,
      error: 'Cle API BestDebrid non configuree sur le backend'
    });
  }

  return res.json({
    success: true,
    apiKey
  });
});

module.exports = router;
