const crypto = require('crypto');
const axios = require('axios');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const { BIP32Factory } = require('bip32');

const { invalidateVipCache } = require('../checkVip');

bitcoin.initEccLib(ecc);

const bip32 = BIP32Factory(ecc);

const VIP_PACKS = Object.freeze({
  5: { amountEur: 5, vipYears: 1, durationLabel: '1 an' },
  7: { amountEur: 7, vipYears: 1.5, durationLabel: '18 mois' },
  10: { amountEur: 10, vipYears: 2, durationLabel: '2 ans' },
  15: { amountEur: 15, vipYears: 3, durationLabel: '3 ans' },
  20: { amountEur: 20, vipYears: 4, durationLabel: '4 ans' }
});

const VIP_PAYMENT_METHODS = Object.freeze({
  btc: { type: 'crypto', coin: 'btc' },
  ltc: { type: 'crypto', coin: 'ltc' },
  paygate_hosted: { type: 'paygate', coin: null }
});

const DEFAULT_SUPPORT_TELEGRAM_URL = 'https://t.me/movix_site';
const FINAL_STATUSES = new Set(['delivered', 'cancelled']);
const DEFAULT_EXPIRATION_MINUTES = 210;
const PAYGATE_DEFAULT_DOMAIN = 'checkout.paygate.to';
const DEFAULT_PAYGATE_MIN_PAID_RATIO = 0.60;
const DEFAULT_PAYGATE_MIN_AMOUNT_EUR = 6.25;
const DEFAULT_PAYGATE_MIN_PACK_EUR = 7;
const SATOSHI_FACTOR = 1e8;
const PAYGATE_USDC_POLYGON_CONTRACT = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';
const STATUS_REASONS = {
  awaiting_payment: 'Aucun paiement détecté pour le moment.',
  partial_payment: 'Paiement détecté mais montant insuffisant.',
  confirming: 'Paiement détecté, confirmations en cours.',
  paid: 'Paiement confirmé sur la blockchain.',
  delivered: 'Clé VIP livrée.',
  expired: 'Invoice expirée.',
  cancelled: 'Invoice annulée.'
};

const BTC_NETWORK = {
  messagePrefix: '\x18Bitcoin Signed Message:\n',
  bech32: 'bc',
  bip32: {
    public: 0x0488b21e,
    private: 0x0488ade4
  },
  pubKeyHash: 0x00,
  scriptHash: 0x05,
  wif: 0x80
};

const LTC_NETWORK = {
  messagePrefix: '\x19Litecoin Signed Message:\n',
  bech32: 'ltc',
  bip32: {
    public: 0x019da462,
    private: 0x019d9cfe
  },
  pubKeyHash: 0x30,
  scriptHash: 0x32,
  wif: 0xb0
};

const EXTENDED_KEY_FORMATS = {
  btc: {
    xpub: { bip32Public: 0x0488b21e, defaultAddressType: 'legacy' },
    ypub: { bip32Public: 0x049d7cb2, defaultAddressType: 'p2sh-segwit' },
    zpub: { bip32Public: 0x04b24746, defaultAddressType: 'segwit' }
  },
  ltc: {
    xpub: { bip32Public: 0x0488b21e, defaultAddressType: 'legacy' },
    Ltub: { bip32Public: 0x019da462, defaultAddressType: 'legacy' }
  }
};

const BLOCKCYPHER_MAPPING = {
  btc: 'btc/main',
  ltc: 'ltc/main'
};

const PAYGATE_PRICE_CONVERT_COINS = new Set(['polygon_pol', 'eth', 'bep20_bnb']);

function parseNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundFiat(value) {
  return Number(parseNumber(value).toFixed(2));
}

function roundCrypto(value) {
  return Number(parseNumber(value).toFixed(8));
}

function toSqlDateTime(dateInput) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function fromSqlDateTime(dateInput) {
  if (!dateInput) return null;
  return new Date(dateInput);
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function getSupportTelegramUrl() {
  return process.env.VIP_SUPPORT_TELEGRAM_URL || DEFAULT_SUPPORT_TELEGRAM_URL;
}

function buildFrontendUrl(pathname) {
  const baseUrl = normalizeBaseUrl(process.env.FRONTEND_BASE_URL);
  if (!baseUrl) return pathname;
  return `${baseUrl}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
}

function getInvoicePath(publicId) {
  return `/vip/invoice/${encodeURIComponent(publicId)}`;
}

function getGiftPath(giftToken) {
  return `/vip/cadeau/${encodeURIComponent(giftToken)}`;
}

function hashIp(ipAddress) {
  if (!ipAddress) return null;
  const secret = process.env.JWT_SECRET || 'movix-vip-ip';
  return crypto.createHmac('sha256', secret).update(ipAddress).digest('hex');
}

function getClientIp(req) {
  return req.headers['cf-connecting-ip']
    || req.headers['x-forwarded-for']?.split(',')[0].trim()
    || req.ip
    || null;
}

function resolvePack(packEur) {
  const normalizedAmount = parseNumber(packEur);
  return VIP_PACKS[normalizedAmount] || null;
}

function normalizePaymentMethod(method, fallbackCoin = null) {
  const normalized = String(method || '').trim().toLowerCase();
  if (VIP_PAYMENT_METHODS[normalized]) {
    return normalized;
  }

  return normalizeCoin(fallbackCoin);
}

function normalizeCoin(coin) {
  const normalized = String(coin || '').trim().toLowerCase();
  return normalized === 'btc' || normalized === 'ltc' ? normalized : null;
}

function isCryptoPaymentMethod(paymentMethod) {
  return paymentMethod === 'btc' || paymentMethod === 'ltc';
}

function isPaygatePaymentMethod(paymentMethod) {
  return paymentMethod === 'paygate_hosted';
}

function getInvoicePaymentMethod(invoice) {
  if (!invoice) return null;

  const paymentMethod = normalizePaymentMethod(invoice.payment_method, invoice.coin);
  if (paymentMethod) {
    return paymentMethod;
  }

  return null;
}

function normalizeRecipientMode(mode) {
  const normalized = String(mode || '').trim().toLowerCase();
  return normalized === 'self' || normalized === 'gift' ? normalized : null;
}

function normalizeEmailAddress(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  const isValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
  return isValid ? normalized : null;
}

function getCoinEnvPrefix(coin) {
  return coin === 'btc' ? 'BTC' : 'LTC';
}

function normalizeAddressType(addressType, fallback) {
  const normalized = String(addressType || '').trim().toLowerCase();
  if (normalized === 'legacy' || normalized === 'segwit' || normalized === 'p2sh-segwit') {
    return normalized;
  }
  return fallback;
}

function getPaygateCheckoutDomain() {
  return String(process.env.VIP_PAYGATE_DOMAIN || PAYGATE_DEFAULT_DOMAIN)
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
}

function getPaygatePayoutWallet() {
  const wallet = String(process.env.VIP_PAYGATE_SETTLEMENT_WALLET || '').trim();
  if (!wallet) {
    return '';
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    throw new Error('VIP_PAYGATE_SETTLEMENT_WALLET invalide: adresse EVM/Polygon attendue');
  }

  if (wallet.toLowerCase() === PAYGATE_USDC_POLYGON_CONTRACT) {
    throw new Error('VIP_PAYGATE_SETTLEMENT_WALLET invalide: utilise ton wallet, pas le contrat USDC Polygon');
  }

  return wallet;
}

function getPaygateMinPaidRatio() {
  const ratio = parseNumber(process.env.VIP_PAYGATE_MIN_PAID_RATIO, DEFAULT_PAYGATE_MIN_PAID_RATIO);
  return Math.min(1, Math.max(0.5, ratio));
}

function getPaygateMinimumAmountEur() {
  return roundFiat(Math.max(
    0,
    parseNumber(process.env.VIP_PAYGATE_MIN_AMOUNT_EUR, DEFAULT_PAYGATE_MIN_AMOUNT_EUR)
  ));
}

function getPaygateCheckoutAmountEur(amountEur) {
  return roundFiat(Math.max(parseNumber(amountEur), getPaygateMinimumAmountEur()));
}

function isPaygatePackAllowed(pack) {
  if (!pack) {
    return false;
  }

  return parseNumber(pack.amountEur, 0) >= parseNumber(
    process.env.VIP_PAYGATE_MIN_PACK_EUR,
    DEFAULT_PAYGATE_MIN_PACK_EUR
  );
}

function getPaygateBranding() {
  return {
    logo: String(process.env.VIP_PAYGATE_LOGO_URL || '').trim(),
    background: String(process.env.VIP_PAYGATE_BACKGROUND || '').trim(),
    theme: String(process.env.VIP_PAYGATE_THEME || '').trim(),
    button: String(process.env.VIP_PAYGATE_BUTTON || '').trim()
  };
}

function getPaygateCallbackBaseUrl(context = {}) {
  const envBaseUrl = normalizeBaseUrl(process.env.VIP_PAYGATE_CALLBACK_BASE_URL);
  if (envBaseUrl) {
    return envBaseUrl;
  }

  return normalizeBaseUrl(context.callbackBaseUrl);
}

function buildPaygateCallbackUrl(publicId, callbackNonce, context = {}) {
  const callbackBaseUrl = getPaygateCallbackBaseUrl(context);
  if (!callbackBaseUrl) {
    throw new Error('VIP PayGate callback URL introuvable');
  }

  const query = new URLSearchParams({
    publicId,
    nonce: callbackNonce
  });

  return `${callbackBaseUrl}/api/vip/paygate/callback?${query.toString()}`;
}

function buildPaygateCheckoutUrl({ trackingAddress, amountEur, payerEmail, branding = {} }) {
  const domain = getPaygateCheckoutDomain();
  if (!domain) {
    throw new Error('VIP PayGate domain manquant');
  }

  const queryParts = [
    `address=${String(trackingAddress || '').trim()}`,
    `amount=${roundFiat(amountEur).toFixed(2)}`,
    `email=${encodeURIComponent(String(payerEmail || '').trim())}`,
    'currency=EUR'
  ];

  if (branding.logo) queryParts.push(`logo=${encodeURIComponent(branding.logo)}`);
  if (branding.background) queryParts.push(`background=${encodeURIComponent(branding.background)}`);
  if (branding.theme) queryParts.push(`theme=${encodeURIComponent(branding.theme)}`);
  if (branding.button) queryParts.push(`button=${encodeURIComponent(branding.button)}`);

  return `https://${domain}/pay.php?${queryParts.join('&')}`;
}

function resolvePaygateCheckoutUrl(invoice) {
  if (!invoice) {
    return null;
  }

  const trackingAddress = String(invoice.paygate_tracking_address || invoice.payment_address || '').trim();
  const payerEmail = normalizeEmailAddress(invoice.paygate_payer_email);

  if (!trackingAddress || !payerEmail) {
    return invoice.paygate_checkout_url || null;
  }

  try {
    return buildPaygateCheckoutUrl({
      trackingAddress,
      amountEur: getPaygateCheckoutAmountEur(invoice.amount_eur),
      payerEmail,
      branding: getPaygateBranding()
    });
  } catch (error) {
    return invoice.paygate_checkout_url || null;
  }
}

function getStartDerivationIndex(coin) {
  const envPrefix = getCoinEnvPrefix(coin);
  return Math.max(0, parseNumber(process.env[`VIP_${envPrefix}_START_INDEX`], 0));
}

function getExtendedKeyFormat(coin, extendedKey) {
  const formats = EXTENDED_KEY_FORMATS[coin] || {};
  return Object.entries(formats).find(([prefix]) => extendedKey.startsWith(prefix)) || null;
}

function derivePaymentAddress(coin, derivationIndex) {
  const envPrefix = getCoinEnvPrefix(coin);
  const xpub = String(process.env[`VIP_${envPrefix}_XPUB`] || '').trim();
  if (!xpub) {
    throw new Error(`VIP_${envPrefix}_XPUB manquant`);
  }

  const formatEntry = getExtendedKeyFormat(coin, xpub);
  if (!formatEntry) {
    throw new Error(`Format de xpub non supporté pour ${coin.toUpperCase()}`);
  }

  const [, format] = formatEntry;
  const baseNetwork = coin === 'btc' ? BTC_NETWORK : LTC_NETWORK;
  const addressType = normalizeAddressType(
    process.env[`VIP_${envPrefix}_ADDRESS_TYPE`],
    format.defaultAddressType
  );

  const parsingNetwork = {
    ...baseNetwork,
    bip32: {
      public: format.bip32Public,
      private: baseNetwork.bip32.private
    }
  };

  const accountNode = bip32.fromBase58(xpub, parsingNetwork);
  const chainIndex = parseNumber(process.env[`VIP_${envPrefix}_CHAIN`], 0);
  const childNode = accountNode.derive(chainIndex).derive(derivationIndex);
  const publicKey = Buffer.from(childNode.publicKey);

  let payment;
  if (addressType === 'segwit') {
    payment = bitcoin.payments.p2wpkh({ pubkey: publicKey, network: baseNetwork });
  } else if (addressType === 'p2sh-segwit') {
    payment = bitcoin.payments.p2sh({
      redeem: bitcoin.payments.p2wpkh({ pubkey: publicKey, network: baseNetwork }),
      network: baseNetwork
    });
  } else {
    payment = bitcoin.payments.p2pkh({ pubkey: publicKey, network: baseNetwork });
  }

  if (!payment.address) {
    throw new Error(`Impossible de dériver une adresse ${coin.toUpperCase()}`);
  }

  return {
    address: payment.address,
    addressType,
    derivationIndex
  };
}

async function fetchCoinbaseSpotPrices(coin) {
  const symbol = coin.toUpperCase();
  const [eurResponse, usdResponse] = await Promise.all([
    axios.get(`https://api.coinbase.com/v2/prices/${symbol}-EUR/spot`, { timeout: 15000 }),
    axios.get(`https://api.coinbase.com/v2/prices/${symbol}-USD/spot`, { timeout: 15000 })
  ]);

  return {
    eurPricePerCoin: parseNumber(eurResponse.data?.data?.amount),
    usdPricePerCoin: parseNumber(usdResponse.data?.data?.amount)
  };
}

async function fetchCoinGeckoSpotPrices(coin) {
  const coinId = coin === 'btc' ? 'bitcoin' : 'litecoin';
  const response = await axios.get(
    'https://api.coingecko.com/api/v3/simple/price',
    {
      params: {
        ids: coinId,
        vs_currencies: 'eur,usd'
      },
      timeout: 15000
    }
  );

  return {
    eurPricePerCoin: parseNumber(response.data?.[coinId]?.eur),
    usdPricePerCoin: parseNumber(response.data?.[coinId]?.usd)
  };
}

async function buildPricingSnapshot(coin, amountEur) {
  let prices;
  try {
    prices = await fetchCoinbaseSpotPrices(coin);
  } catch (error) {
    prices = await fetchCoinGeckoSpotPrices(coin);
  }

  if (!prices.eurPricePerCoin || !prices.usdPricePerCoin) {
    throw new Error(`Impossible de récupérer le prix ${coin.toUpperCase()}`);
  }

  return {
    amountEur: roundFiat(amountEur),
    amountUsd: roundFiat((amountEur / prices.eurPricePerCoin) * prices.usdPricePerCoin),
    amountCryptoExpected: roundCrypto(amountEur / prices.eurPricePerCoin),
    eurPricePerCoin: roundFiat(prices.eurPricePerCoin),
    usdPricePerCoin: roundFiat(prices.usdPricePerCoin)
  };
}

async function fetchPaygateConvertedUsd(amount, fromCurrency = 'eur') {
  const response = await axios.get(
    'https://api.paygate.to/control/convert.php',
    {
      params: {
        value: roundFiat(amount).toFixed(2),
        from: String(fromCurrency || 'eur').trim().toLowerCase()
      },
      timeout: 15000
    }
  );

  const usdAmount = parseNumber(response.data?.value_coin);
  if (!usdAmount) {
    throw new Error('Impossible de convertir le montant via PayGate');
  }

  return roundFiat(usdAmount);
}

async function fetchPaygateTemporaryWallet(callbackUrl) {
  const payoutWallet = getPaygatePayoutWallet();
  if (!payoutWallet) {
    throw new Error('VIP_PAYGATE_SETTLEMENT_WALLET manquant');
  }

  const response = await axios.get(
    'https://api.paygate.to/control/wallet.php',
    {
      params: {
        address: payoutWallet,
        callback: callbackUrl
      },
      timeout: 15000
    }
  );

  const trackingAddress = String(response.data?.address_in || '').trim();
  const temporaryWalletAddress = String(response.data?.polygon_address_in || '').trim();
  const callbackUrlFromGateway = String(response.data?.callback_url || '').trim();

  if (!trackingAddress) {
    throw new Error('PayGate n\'a pas retourné d\'adresse de suivi');
  }

  return {
    trackingAddress,
    temporaryWalletAddress: temporaryWalletAddress || null,
    callbackUrl: callbackUrlFromGateway || null
  };
}

async function normalizePaygatePaidUsdValue(receivedCoin, paidValue) {
  const rawValue = parseNumber(paidValue);
  if (!rawValue) {
    return 0;
  }

  const normalizedCoin = String(receivedCoin || '').trim().toLowerCase();
  if (!PAYGATE_PRICE_CONVERT_COINS.has(normalizedCoin)) {
    return roundFiat(rawValue);
  }

  try {
    const coinPath = normalizedCoin.replace('_', '/');
    const response = await axios.get(
      `https://api.paygate.to/crypto/${coinPath}/info.php`,
      { timeout: 15000 }
    );
    const usdPrice = parseNumber(response.data?.prices?.USD);
    if (!usdPrice) {
      return roundFiat(rawValue);
    }

    return roundFiat(rawValue * usdPrice);
  } catch (error) {
    return roundFiat(rawValue);
  }
}

function buildQrPayload(coin, address, amountCryptoExpected) {
  const scheme = coin === 'btc' ? 'bitcoin' : 'litecoin';
  return `${scheme}:${address}?amount=${roundCrypto(amountCryptoExpected).toFixed(8)}`;
}

async function reserveDerivationIndex(pool, coin) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [rows] = await connection.execute(
      'SELECT next_index FROM vip_derivation_counters WHERE coin = ? FOR UPDATE',
      [coin]
    );

    const startIndex = getStartDerivationIndex(coin);
    let derivationIndex = startIndex;
    if (rows.length === 0) {
      await connection.execute(
        'INSERT INTO vip_derivation_counters (coin, next_index, created_at, updated_at) VALUES (?, ?, NOW(), NOW())',
        [coin, derivationIndex + 1]
      );
    } else {
      derivationIndex = Math.max(parseNumber(rows[0].next_index, 0), startIndex);
      await connection.execute(
        'UPDATE vip_derivation_counters SET next_index = ?, updated_at = NOW() WHERE coin = ?',
        [derivationIndex + 1, coin]
      );
    }

    await connection.commit();
    return derivationIndex;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function logVipInvoiceEvent(db, invoiceId, eventType, message, payload, actorType = 'system', actorId = null) {
  await db.execute(
    `INSERT INTO vip_invoice_events
      (invoice_id, event_type, actor_type, actor_id, message, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NOW())`,
    [
      invoiceId,
      eventType,
      actorType,
      actorId,
      message || null,
      payload ? JSON.stringify(payload) : null
    ]
  );
}

async function fetchInvoiceByPublicId(pool, publicId) {
  const [rows] = await pool.execute(
    'SELECT * FROM vip_invoices WHERE public_id = ? LIMIT 1',
    [publicId]
  );
  return rows[0] || null;
}

async function fetchInvoiceById(pool, invoiceId) {
  const [rows] = await pool.execute(
    'SELECT * FROM vip_invoices WHERE id = ? LIMIT 1',
    [invoiceId]
  );
  return rows[0] || null;
}

async function fetchInvoiceByGiftToken(pool, giftToken) {
  const [rows] = await pool.execute(
    'SELECT * FROM vip_invoices WHERE gift_token = ? LIMIT 1',
    [giftToken]
  );
  return rows[0] || null;
}

async function generateUniqueVipKey(db) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = `VIP-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
    const [rows] = await db.execute(
      'SELECT key_value FROM access_keys WHERE key_value = ? LIMIT 1',
      [candidate]
    );
    if (rows.length === 0) {
      return candidate;
    }
  }

  throw new Error('Impossible de générer une clé VIP unique');
}

function buildDurationLabel(vipYears) {
  const normalizedYears = parseNumber(vipYears, 1);
  const totalMonths = Math.max(1, Math.round(normalizedYears * 12));

  if (totalMonths % 12 === 0) {
    const totalYears = totalMonths / 12;
    return `${totalYears} ${totalYears > 1 ? 'ans' : 'an'}`;
  }

  return `${totalMonths} mois`;
}

async function deliverInvoiceIfReady(pool, invoiceId, actorType = 'system', actorId = null, reason = 'auto') {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [rows] = await connection.execute(
      'SELECT * FROM vip_invoices WHERE id = ? FOR UPDATE',
      [invoiceId]
    );

    if (rows.length === 0) {
      throw new Error('Invoice introuvable');
    }

    const invoice = rows[0];
    if (invoice.status === 'delivered' && invoice.vip_key_value) {
      await connection.commit();
      return invoice;
    }

    if (invoice.status !== 'paid') {
      await connection.commit();
      return invoice;
    }

    const vipYears = parseNumber(invoice.vip_years, 0);
    const totalMonths = Math.max(1, Math.round(vipYears * 12));
    const durationLabel = buildDurationLabel(vipYears);
    const keyValue = await generateUniqueVipKey(connection);
    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + totalMonths);

    await connection.execute(
      `INSERT INTO access_keys
        (key_value, active, used, duree_validite, expires_at, created_at, updated_at)
        VALUES (?, 1, 0, ?, ?, NOW(), NOW())`,
      [keyValue, durationLabel, expiresAt.getTime()]
    );

    await connection.execute(
      `UPDATE vip_invoices
        SET status = 'delivered',
            vip_key_value = ?,
            delivered_at = COALESCE(delivered_at, NOW()),
            paid_at = COALESCE(paid_at, NOW()),
            updated_at = NOW()
        WHERE id = ?`,
      [keyValue, invoiceId]
    );

    await logVipInvoiceEvent(
      connection,
      invoiceId,
      'invoice_delivered',
      'Clé VIP livrée automatiquement.',
      {
        reason,
        keyValue,
        vipYears,
        durationMonths: totalMonths,
        durationLabel
      },
      actorType,
      actorId
    );

    await connection.commit();
    invalidateVipCache(keyValue);

    return fetchInvoiceById(pool, invoiceId);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

function getRequiredConfirmations(coin) {
  const envPrefix = getCoinEnvPrefix(coin);
  return Math.max(1, parseNumber(process.env[`VIP_${envPrefix}_CONFIRMATIONS`], 1));
}

async function fetchAddressActivity(coin, address, options = {}) {
  const chain = BLOCKCYPHER_MAPPING[coin];
  if (!chain) {
    throw new Error(`Coin non supporté pour la surveillance: ${coin}`);
  }

  const response = await axios.get(
    `https://api.blockcypher.com/v1/${chain}/addrs/${encodeURIComponent(address)}/full`,
    {
      params: {
        limit: 50,
        txlimit: 50,
        ...(process.env.BLOCKCYPHER_TOKEN ? { token: process.env.BLOCKCYPHER_TOKEN } : {})
      },
      timeout: 15000,
      validateStatus: (status) => status >= 200 && status < 500
    }
  );

  if (response.status === 404) {
    return {
      totalReceived: 0,
      confirmedReceived: 0,
      confirmations: 0,
      txHashes: []
    };
  }

  if (response.status >= 400) {
    throw new Error(`Erreur BlockCypher ${response.status}`);
  }

  const txs = Array.isArray(response.data?.txs) ? response.data.txs : [];
  let totalReceived = 0;
  let confirmedReceived = 0;
  let maxConfirmations = 0;
  const txHashes = [];
  const requiredConfirmations = getRequiredConfirmations(coin);
  const ignoreBeforeMs = options.ignoreBefore ? new Date(options.ignoreBefore).getTime() : 0;
  const ignoreBeforeToleranceMs = 1500;

  for (const tx of txs) {
    const txTimestamp = Date.parse(tx?.received || tx?.confirmed || '');
    if (
      ignoreBeforeMs
      && (!Number.isFinite(txTimestamp) || txTimestamp < (ignoreBeforeMs - ignoreBeforeToleranceMs))
    ) {
      continue;
    }

    let amountForAddress = 0;
    const confirmations = parseNumber(tx.confirmations, 0);
    for (const output of Array.isArray(tx.outputs) ? tx.outputs : []) {
      if (Array.isArray(output.addresses) && output.addresses.includes(address)) {
        amountForAddress += parseNumber(output.value, 0) / SATOSHI_FACTOR;
      }
    }

    if (amountForAddress <= 0) {
      continue;
    }

    totalReceived += amountForAddress;
    if (confirmations >= requiredConfirmations) {
      confirmedReceived += amountForAddress;
    }
    if (confirmations > maxConfirmations) {
      maxConfirmations = confirmations;
    }
    if (tx.hash) {
      txHashes.push(tx.hash);
    }
  }

  return {
    totalReceived: roundCrypto(totalReceived),
    confirmedReceived: roundCrypto(confirmedReceived),
    confirmations: maxConfirmations,
    txHashes
  };
}

function determineInvoiceStatus(invoice, addressActivity) {
  const expected = roundCrypto(parseNumber(invoice.amount_crypto_expected));
  const received = roundCrypto(addressActivity.totalReceived);
  const confirmed = roundCrypto(addressActivity.confirmedReceived);
  const isExpired = fromSqlDateTime(invoice.expires_at)?.getTime() < Date.now();

  if (confirmed >= expected && expected > 0) {
    return 'paid';
  }

  if (received >= expected && expected > 0) {
    return 'confirming';
  }

  if (received > 0) {
    return 'partial_payment';
  }

  if (isExpired) {
    return 'expired';
  }

  return 'awaiting_payment';
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function serializePublicInvoice(invoice) {
  if (!invoice) return null;

  const paymentMethod = getInvoicePaymentMethod(invoice);
  const isCryptoInvoice = isCryptoPaymentMethod(paymentMethod);
  const invoicePath = getInvoicePath(invoice.public_id);
  const giftPath = invoice.gift_token ? getGiftPath(invoice.gift_token) : null;
  const isGiftDelivered = invoice.recipient_mode === 'gift' && invoice.status === 'delivered' && invoice.gift_token;
  const isSelfDelivered = invoice.recipient_mode === 'self' && invoice.status === 'delivered' && invoice.vip_key_value;

  return {
    publicId: invoice.public_id,
    status: invoice.status,
    paymentMethod,
    coin: isCryptoInvoice ? normalizeCoin(invoice.coin) : null,
    packEur: roundFiat(invoice.pack_eur),
    amountEur: roundFiat(invoice.amount_eur),
    amountUsd: roundFiat(invoice.amount_usd),
    amountCryptoExpected: isCryptoInvoice ? roundCrypto(invoice.amount_crypto_expected) : null,
    amountCryptoReceived: isCryptoInvoice ? roundCrypto(invoice.amount_crypto_received) : null,
    vipYears: parseNumber(invoice.vip_years),
    durationLabel: buildDurationLabel(parseNumber(invoice.vip_years)),
    recipientMode: invoice.recipient_mode,
    paymentAddress: isCryptoInvoice ? invoice.payment_address : null,
    trackingAddress: isPaygatePaymentMethod(paymentMethod)
      ? (invoice.paygate_tracking_address || invoice.payment_address || null)
      : null,
    checkoutUrl: isPaygatePaymentMethod(paymentMethod)
      ? resolvePaygateCheckoutUrl(invoice)
      : null,
    addressType: isCryptoInvoice ? (invoice.address_type || null) : null,
    confirmations: isCryptoInvoice ? parseNumber(invoice.confirmations) : null,
    requiredConfirmations: isCryptoInvoice ? parseNumber(invoice.required_confirmations) : null,
    expiresAt: fromSqlDateTime(invoice.expires_at)?.toISOString() || null,
    paidAt: fromSqlDateTime(invoice.paid_at)?.toISOString() || null,
    deliveredAt: fromSqlDateTime(invoice.delivered_at)?.toISOString() || null,
    createdAt: fromSqlDateTime(invoice.created_at)?.toISOString() || null,
    qrPayload: isCryptoInvoice ? invoice.qr_payload : null,
    invoicePath,
    invoiceUrl: buildFrontendUrl(invoicePath),
    giftPath: isGiftDelivered ? giftPath : null,
    giftUrl: isGiftDelivered ? buildFrontendUrl(giftPath) : null,
    vipKey: isSelfDelivered ? invoice.vip_key_value : null,
    supportTelegramUrl: getSupportTelegramUrl()
  };
}

function serializeAdminInvoice(invoice) {
  if (!invoice) return null;

  return {
    ...serializePublicInvoice(invoice),
    id: parseNumber(invoice.id),
    derivationIndex: parseNumber(invoice.derivation_index, -1) >= 0
      ? parseNumber(invoice.derivation_index)
      : null,
    txHash: invoice.tx_hash || null,
    giftToken: invoice.gift_token || null,
    giftSealed: Boolean(invoice.gift_sealed),
    giftUnsealedAt: fromSqlDateTime(invoice.gift_unsealed_at)?.toISOString() || null,
    giftUnsealCount: parseNumber(invoice.gift_unseal_count),
    createdByUserId: invoice.created_by_user_id || null,
    createdByUserType: invoice.created_by_user_type || null,
    createdBySessionId: invoice.created_by_session_id || null,
    createdIpHash: invoice.created_ip_hash || null,
    payerEmail: invoice.paygate_payer_email || null,
    temporaryWalletAddress: invoice.paygate_temporary_wallet_address || null,
    callbackUrl: invoice.paygate_callback_url || null,
    paidCoin: invoice.paygate_paid_coin || null,
    paidValue: invoice.paygate_paid_value !== null && invoice.paygate_paid_value !== undefined
      ? roundFiat(invoice.paygate_paid_value)
      : null,
    paidTxid: invoice.paygate_paid_txid || null,
    reason: STATUS_REASONS[invoice.status] || null
  };
}

function serializeGift(invoice) {
  if (!invoice || invoice.recipient_mode !== 'gift') {
    return null;
  }

  return {
    giftToken: invoice.gift_token,
    status: invoice.gift_sealed ? 'sealed' : 'unsealed',
    invoiceStatus: invoice.status,
    vipYears: parseNumber(invoice.vip_years),
    durationLabel: buildDurationLabel(parseNumber(invoice.vip_years)),
    createdAt: fromSqlDateTime(invoice.created_at)?.toISOString() || null,
    unsealedAt: fromSqlDateTime(invoice.gift_unsealed_at)?.toISOString() || null,
    vipKey: !invoice.gift_sealed && invoice.status === 'delivered' ? invoice.vip_key_value : null,
    supportTelegramUrl: getSupportTelegramUrl()
  };
}

async function refreshInvoiceStatus(pool, invoiceInput, options = {}) {
  const invoice = invoiceInput?.id ? invoiceInput : await fetchInvoiceById(pool, invoiceInput);
  if (!invoice) {
    return null;
  }

  if (FINAL_STATUSES.has(invoice.status)) {
    return invoice;
  }

  const now = Date.now();
  const nextCheckAt = invoice.next_check_at ? new Date(invoice.next_check_at).getTime() : 0;
  const force = options.force === true;

  if (!force && nextCheckAt > now) {
    return invoice;
  }

  const paymentMethod = getInvoicePaymentMethod(invoice);
  if (isPaygatePaymentMethod(paymentMethod)) {
    const isExpired = fromSqlDateTime(invoice.expires_at)?.getTime() < Date.now();
    const shouldExpire = invoice.status === 'awaiting_payment' && isExpired;

    if (shouldExpire) {
      await pool.execute(
        `UPDATE vip_invoices
          SET status = 'expired',
              next_check_at = DATE_ADD(NOW(), INTERVAL 25 SECOND),
              updated_at = NOW()
          WHERE id = ?`,
        [invoice.id]
      );

      await logVipInvoiceEvent(
        pool,
        invoice.id,
        'invoice_status_updated',
        STATUS_REASONS.expired,
        {
          from: invoice.status,
          to: 'expired'
        },
        options.actorType || 'system',
        options.actorId || null
      );
    } else {
      await pool.execute(
        'UPDATE vip_invoices SET next_check_at = DATE_ADD(NOW(), INTERVAL 25 SECOND), updated_at = NOW() WHERE id = ?',
        [invoice.id]
      );
    }

    const refreshedInvoice = await fetchInvoiceById(pool, invoice.id);
    if (refreshedInvoice?.status === 'paid') {
      return deliverInvoiceIfReady(
        pool,
        refreshedInvoice.id,
        options.actorType || 'system',
        options.actorId || null,
        'paygate_callback'
      );
    }

    return refreshedInvoice;
  }

  const addressActivity = await fetchAddressActivity(invoice.coin, invoice.payment_address, {
    ignoreBefore: invoice.created_at
  });
  const newStatus = determineInvoiceStatus(invoice, addressActivity);
  const amountReceived = roundCrypto(addressActivity.totalReceived);
  const txHash = addressActivity.txHashes[0] || invoice.tx_hash || null;
  const shouldMarkPaidAt = newStatus === 'paid' && !invoice.paid_at;
  const hasChanged = newStatus !== invoice.status
    || roundCrypto(parseNumber(invoice.amount_crypto_received)) !== amountReceived
    || parseNumber(invoice.confirmations) !== addressActivity.confirmations
    || txHash !== (invoice.tx_hash || null);

  if (hasChanged) {
    await pool.execute(
      `UPDATE vip_invoices
        SET status = ?,
            amount_crypto_received = ?,
            confirmations = ?,
            tx_hash = ?,
            paid_at = CASE WHEN ? THEN COALESCE(paid_at, NOW()) ELSE paid_at END,
            next_check_at = DATE_ADD(NOW(), INTERVAL 25 SECOND),
            updated_at = NOW()
        WHERE id = ?`,
      [
        newStatus,
        amountReceived,
        addressActivity.confirmations,
        txHash,
        shouldMarkPaidAt ? 1 : 0,
        invoice.id
      ]
    );

    await logVipInvoiceEvent(
      pool,
      invoice.id,
      'invoice_status_updated',
      STATUS_REASONS[newStatus] || 'Statut d\'invoice mis à jour.',
      {
        from: invoice.status,
        to: newStatus,
        amountCryptoReceived: amountReceived,
        confirmations: addressActivity.confirmations,
        txHash
      },
      options.actorType || 'system',
      options.actorId || null
    );
  } else {
    await pool.execute(
      'UPDATE vip_invoices SET next_check_at = DATE_ADD(NOW(), INTERVAL 25 SECOND), updated_at = NOW() WHERE id = ?',
      [invoice.id]
    );
  }

  const refreshedInvoice = await fetchInvoiceById(pool, invoice.id);
  if (refreshedInvoice?.status === 'paid') {
    return deliverInvoiceIfReady(
      pool,
      refreshedInvoice.id,
      options.actorType || 'system',
      options.actorId || null,
      'blockchain_confirmed'
    );
  }

  return refreshedInvoice;
}

async function listVipInvoices(pool, options = {}) {
  const page = Math.max(1, parseNumber(options.page, 1));
  const limit = Math.min(100, Math.max(1, parseNumber(options.limit, 30)));
  const offset = (page - 1) * limit;
  const conditions = [];
  const params = [];

  if (options.status) {
    conditions.push('status = ?');
    params.push(options.status);
  }

  if (options.search) {
    conditions.push(`(
      public_id LIKE ?
      OR payment_address LIKE ?
      OR COALESCE(tx_hash, '') LIKE ?
      OR COALESCE(vip_key_value, '') LIKE ?
      OR COALESCE(gift_token, '') LIKE ?
      OR COALESCE(paygate_tracking_address, '') LIKE ?
      OR COALESCE(paygate_paid_txid, '') LIKE ?
      OR COALESCE(paygate_payer_email, '') LIKE ?
    )`);
    const searchTerm = `%${options.search}%`;
    params.push(
      searchTerm,
      searchTerm,
      searchTerm,
      searchTerm,
      searchTerm,
      searchTerm,
      searchTerm,
      searchTerm
    );
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const [rows] = await pool.execute(
    `SELECT * FROM vip_invoices ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const [countRows] = await pool.execute(
    `SELECT COUNT(*) AS total FROM vip_invoices ${whereClause}`,
    params
  );

  const total = parseNumber(countRows[0]?.total, 0);

  return {
    items: rows.map(serializeAdminInvoice),
    total,
    page,
    limit,
    hasMore: offset + rows.length < total
  };
}

async function getVipInvoiceDetails(pool, invoiceId) {
  const invoice = await fetchInvoiceById(pool, invoiceId);
  if (!invoice) {
    return null;
  }

  const [events] = await pool.execute(
    'SELECT * FROM vip_invoice_events WHERE invoice_id = ? ORDER BY created_at DESC, id DESC',
    [invoiceId]
  );

  return {
    invoice: serializeAdminInvoice(invoice),
    events: events.map((event) => ({
      id: event.id,
      eventType: event.event_type,
      actorType: event.actor_type,
      actorId: event.actor_id,
      message: event.message,
      payload: event.payload_json ? safeJsonParse(event.payload_json) : null,
      createdAt: fromSqlDateTime(event.created_at)?.toISOString() || null
    }))
  };
}

function createVipInvoiceError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function createCryptoVipInvoice(pool, payload, context = {}) {
  const pack = payload.pack;
  const coin = payload.coin;
  const recipientMode = payload.recipientMode;

  if (!pack || !coin || !recipientMode) {
    throw createVipInvoiceError('Paramètres d\'invoice invalides');
  }

  const pricing = await buildPricingSnapshot(coin, pack.amountEur);
  const derivationIndex = await reserveDerivationIndex(pool, coin);
  const derivedAddress = derivePaymentAddress(coin, derivationIndex);
  const publicId = `inv_${crypto.randomBytes(12).toString('hex')}`;
  const giftToken = recipientMode === 'gift' ? `gift_${crypto.randomBytes(16).toString('hex')}` : null;
  const expiresAt = new Date(Date.now() + (Math.max(1, parseNumber(process.env.VIP_INVOICE_EXPIRATION_MINUTES, DEFAULT_EXPIRATION_MINUTES)) * 60 * 1000));
  const qrPayload = buildQrPayload(coin, derivedAddress.address, pricing.amountCryptoExpected);
  const createdIpHash = hashIp(context.ipAddress);
  const auth = context.auth || null;

  const [insertResult] = await pool.execute(
    `INSERT INTO vip_invoices
      (public_id, payment_method, status, coin, pack_eur, amount_eur, amount_usd, amount_crypto_expected,
       amount_crypto_received, vip_years, recipient_mode, payment_address, address_type,
       derivation_index, confirmations, required_confirmations, tx_hash, qr_payload, gift_token,
       gift_sealed, gift_unsealed_at, gift_unseal_count, gift_unsealed_by_ip_hash,
       vip_key_value, created_by_user_id, created_by_user_type, created_by_session_id,
       created_ip_hash, expires_at, next_check_at, created_at, updated_at)
      VALUES (?, ?, 'awaiting_payment', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?, 1, NULL, 0, NULL, NULL, ?, ?, ?, ?, ?, NOW(), NOW(), NOW())`,
    [
      publicId,
      coin,
      coin,
      pack.amountEur,
      pricing.amountEur,
      pricing.amountUsd,
      pricing.amountCryptoExpected,
      pack.vipYears,
      recipientMode,
      derivedAddress.address,
      derivedAddress.addressType,
      derivationIndex,
      getRequiredConfirmations(coin),
      qrPayload,
      giftToken,
      auth?.userId || null,
      auth?.userType || null,
      auth?.sessionId || null,
      createdIpHash,
      toSqlDateTime(expiresAt)
    ]
  );

  await logVipInvoiceEvent(
    pool,
    insertResult.insertId,
    'invoice_created',
    'Invoice VIP créée.',
    {
      paymentMethod: coin,
      coin,
      packEur: pack.amountEur,
      amountCryptoExpected: pricing.amountCryptoExpected,
      vipYears: pack.vipYears,
      recipientMode,
      derivationIndex,
      paymentAddress: derivedAddress.address
    },
    auth ? 'user' : 'guest',
    auth?.userId || null
  );

  return fetchInvoiceById(pool, insertResult.insertId);
}

async function createPaygateVipInvoice(pool, payload, context = {}) {
  const pack = payload.pack;
  const recipientMode = payload.recipientMode;
  const normalizedEmail = normalizeEmailAddress(payload.payerEmail);

  if (!pack || !recipientMode || !normalizedEmail) {
    throw createVipInvoiceError('Adresse email invalide pour PayGate');
  }

  const publicId = `inv_${crypto.randomBytes(12).toString('hex')}`;
  const callbackNonce = crypto.randomBytes(24).toString('hex');
  const callbackUrl = buildPaygateCallbackUrl(publicId, callbackNonce, context);
  const checkoutAmountEur = getPaygateCheckoutAmountEur(pack.amountEur);
  const amountUsd = await fetchPaygateConvertedUsd(checkoutAmountEur, 'eur');
  const paygateWallet = await fetchPaygateTemporaryWallet(callbackUrl);
  const expiresAt = new Date(Date.now() + (Math.max(1, parseNumber(process.env.VIP_INVOICE_EXPIRATION_MINUTES, DEFAULT_EXPIRATION_MINUTES)) * 60 * 1000));
  const giftToken = recipientMode === 'gift' ? `gift_${crypto.randomBytes(16).toString('hex')}` : null;
  const createdIpHash = hashIp(context.ipAddress);
  const auth = context.auth || null;
  const checkoutUrl = buildPaygateCheckoutUrl({
    trackingAddress: paygateWallet.trackingAddress,
    amountEur: checkoutAmountEur,
    payerEmail: normalizedEmail,
    branding: getPaygateBranding()
  });

  const [insertResult] = await pool.execute(
    `INSERT INTO vip_invoices
      (public_id, payment_method, status, coin, pack_eur, amount_eur, amount_usd, amount_crypto_expected,
       amount_crypto_received, vip_years, recipient_mode, payment_address, address_type,
       derivation_index, confirmations, required_confirmations, tx_hash, qr_payload, gift_token,
       gift_sealed, gift_unsealed_at, gift_unseal_count, gift_unsealed_by_ip_hash,
       vip_key_value, created_by_user_id, created_by_user_type, created_by_session_id,
       created_ip_hash, expires_at, next_check_at, paygate_tracking_address, paygate_temporary_wallet_address,
       paygate_callback_url, paygate_callback_nonce, paygate_checkout_url, paygate_payer_email,
       paygate_paid_coin, paygate_paid_value, paygate_paid_txid, created_at, updated_at)
      VALUES (?, 'paygate_hosted', 'awaiting_payment', NULL, ?, ?, ?, 0, 0, ?, ?, ?, NULL,
        -1, 0, 0, NULL, '', ?, 1, NULL, 0, NULL, NULL, ?, ?, ?, ?, ?, NOW(),
        ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NOW(), NOW())`,
    [
      publicId,
      pack.amountEur,
      checkoutAmountEur,
      amountUsd,
      pack.vipYears,
      recipientMode,
      paygateWallet.trackingAddress,
      giftToken,
      auth?.userId || null,
      auth?.userType || null,
      auth?.sessionId || null,
      createdIpHash,
      toSqlDateTime(expiresAt),
      paygateWallet.trackingAddress,
      paygateWallet.temporaryWalletAddress,
      paygateWallet.callbackUrl || callbackUrl,
      callbackNonce,
      checkoutUrl,
      normalizedEmail
    ]
  );

  await logVipInvoiceEvent(
    pool,
    insertResult.insertId,
    'invoice_created',
    'Invoice VIP PayGate créée.',
    {
      paymentMethod: 'paygate_hosted',
      packEur: pack.amountEur,
      checkoutAmountEur,
      amountUsd,
      vipYears: pack.vipYears,
      recipientMode,
      payerEmail: normalizedEmail,
      trackingAddress: paygateWallet.trackingAddress
    },
    auth ? 'user' : 'guest',
    auth?.userId || null
  );

  return fetchInvoiceById(pool, insertResult.insertId);
}

async function handlePaygateCallback(pool, payload = {}) {
  const publicId = String(payload.publicId || payload.public_id || '').trim();
  const callbackNonce = String(payload.nonce || '').trim();
  const paidCoin = String(payload.coin || '').trim().toLowerCase() || null;
  const paidTxid = String(payload.txid_out || payload.txid || '').trim() || null;
  const rawPaidValue = payload.value_coin;

  if (!publicId) {
    throw createVipInvoiceError('publicId PayGate manquant');
  }
  if (!callbackNonce) {
    throw createVipInvoiceError('nonce PayGate manquant', 403);
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [rows] = await connection.execute(
      'SELECT * FROM vip_invoices WHERE public_id = ? FOR UPDATE',
      [publicId]
    );

    if (rows.length === 0) {
      throw createVipInvoiceError('Invoice PayGate introuvable', 404);
    }

    const invoice = rows[0];
    if (!isPaygatePaymentMethod(getInvoicePaymentMethod(invoice))) {
      throw createVipInvoiceError('Cette invoice n\'utilise pas PayGate', 409);
    }
    if (!invoice.paygate_callback_nonce || invoice.paygate_callback_nonce !== callbackNonce) {
      throw createVipInvoiceError('Nonce PayGate invalide', 403);
    }

    if (invoice.status === 'delivered' || invoice.status === 'cancelled') {
      await connection.commit();
      return invoice;
    }

    const paidValue = await normalizePaygatePaidUsdValue(paidCoin, rawPaidValue);
    const minimumPaidAmount = roundFiat(parseNumber(invoice.amount_usd) * getPaygateMinPaidRatio());
    const nextStatus = paidValue >= minimumPaidAmount && paidValue > 0 ? 'paid' : 'partial_payment';
    const shouldMarkPaidAt = nextStatus === 'paid' && !invoice.paid_at;

    await connection.execute(
      `UPDATE vip_invoices
        SET status = ?,
            tx_hash = COALESCE(?, tx_hash),
            paid_at = CASE WHEN ? THEN COALESCE(paid_at, NOW()) ELSE paid_at END,
            paygate_paid_coin = ?,
            paygate_paid_value = ?,
            paygate_paid_txid = ?,
            next_check_at = DATE_ADD(NOW(), INTERVAL 25 SECOND),
            updated_at = NOW()
        WHERE id = ?`,
      [
        nextStatus,
        paidTxid,
        shouldMarkPaidAt ? 1 : 0,
        paidCoin,
        paidValue,
        paidTxid,
        invoice.id
      ]
    );

    await logVipInvoiceEvent(
      connection,
      invoice.id,
      'invoice_paygate_callback',
      nextStatus === 'paid'
        ? 'Callback PayGate validé, invoice marquée comme payée.'
        : 'Callback PayGate reçu avec montant insuffisant.',
      {
        previousStatus: invoice.status,
        nextStatus,
        paidCoin,
        paidValue,
        paidTxid,
        minimumPaidAmount
      },
      'gateway',
      'paygate'
    );

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  const refreshedInvoice = await fetchInvoiceByPublicId(pool, publicId);
  if (refreshedInvoice?.status === 'paid') {
    return deliverInvoiceIfReady(pool, refreshedInvoice.id, 'gateway', 'paygate', 'paygate_callback');
  }

  return refreshedInvoice;
}

async function createVipInvoice(pool, payload, context = {}) {
  const pack = resolvePack(payload.packEur);
  const paymentMethod = normalizePaymentMethod(payload.paymentMethod, payload.coin);
  const recipientMode = normalizeRecipientMode(payload.recipientMode);

  if (!pack || !paymentMethod || !recipientMode) {
    throw createVipInvoiceError('Paramètres d\'invoice invalides');
  }

  if (isPaygatePaymentMethod(paymentMethod)) {
    if (!isPaygatePackAllowed(pack)) {
      throw createVipInvoiceError('PayGate est indisponible sur le pack 5 EUR. Utilise BTC/LTC ou choisis le pack 7 EUR.');
    }

    const paygateEnabled = String(process.env.VIP_PAYGATE_ENABLED || 'true').trim().toLowerCase();
    if (['0', 'false', 'no', 'off'].includes(paygateEnabled)) {
      throw createVipInvoiceError('Paiement PayGate indisponible pour le moment');
    }

    return createPaygateVipInvoice(
      pool,
      {
        pack,
        recipientMode,
        payerEmail: payload.payerEmail
      },
      context
    );
  }

  return createCryptoVipInvoice(
    pool,
    {
      pack,
      coin: paymentMethod,
      recipientMode
    },
    context
  );
}

async function forceValidateInvoice(pool, invoiceId, admin) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [rows] = await connection.execute(
      'SELECT * FROM vip_invoices WHERE id = ? FOR UPDATE',
      [invoiceId]
    );

    if (rows.length === 0) {
      throw new Error('Invoice introuvable');
    }

    const invoice = rows[0];
    const paymentMethod = getInvoicePaymentMethod(invoice);
    if (invoice.status === 'cancelled') {
      throw new Error('Cette invoice est annulée');
    }
    if (invoice.status !== 'delivered') {
      await connection.execute(
        `UPDATE vip_invoices
          SET status = 'paid',
              confirmations = CASE
                WHEN ? = 'paygate_hosted' THEN confirmations
                ELSE GREATEST(confirmations, required_confirmations)
              END,
              amount_crypto_received = CASE
                WHEN ? = 'paygate_hosted' THEN amount_crypto_received
                WHEN amount_crypto_received < amount_crypto_expected THEN amount_crypto_expected
                ELSE amount_crypto_received
              END,
              paygate_paid_coin = CASE
                WHEN ? = 'paygate_hosted' THEN COALESCE(paygate_paid_coin, 'manual')
                ELSE paygate_paid_coin
              END,
              paygate_paid_value = CASE
                WHEN ? = 'paygate_hosted' THEN COALESCE(paygate_paid_value, amount_usd)
                ELSE paygate_paid_value
              END,
              paid_at = COALESCE(paid_at, NOW()),
              updated_at = NOW()
          WHERE id = ?`,
        [paymentMethod, paymentMethod, paymentMethod, paymentMethod, invoiceId]
      );

      await logVipInvoiceEvent(
        connection,
        invoiceId,
        'invoice_admin_validated',
        'Invoice marquée comme payée par un administrateur.',
        {
          previousStatus: invoice.status,
          adminId: admin?.userId || null
        },
        'admin',
        admin?.userId || null
      );
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  return deliverInvoiceIfReady(pool, invoiceId, 'admin', admin?.userId || null, 'admin_override');
}

async function cancelInvoice(pool, invoiceId, admin) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [rows] = await connection.execute(
      'SELECT * FROM vip_invoices WHERE id = ? FOR UPDATE',
      [invoiceId]
    );

    if (rows.length === 0) {
      throw new Error('Invoice introuvable');
    }

    const invoice = rows[0];
    if (invoice.status === 'delivered') {
      throw new Error('Impossible d\'annuler une invoice déjà livrée');
    }

    if (invoice.status !== 'cancelled') {
      await connection.execute(
        `UPDATE vip_invoices
          SET status = 'cancelled',
              updated_at = NOW()
          WHERE id = ?`,
        [invoiceId]
      );

      await logVipInvoiceEvent(
        connection,
        invoiceId,
        'invoice_cancelled',
        'Invoice annulée par un administrateur.',
        {
          previousStatus: invoice.status,
          adminId: admin?.userId || null
        },
        'admin',
        admin?.userId || null
      );
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  return fetchInvoiceById(pool, invoiceId);
}

async function unsealGift(pool, giftToken, ipAddress) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [rows] = await connection.execute(
      'SELECT * FROM vip_invoices WHERE gift_token = ? FOR UPDATE',
      [giftToken]
    );

    if (rows.length === 0) {
      throw new Error('Cadeau introuvable');
    }

    const invoice = rows[0];
    if (invoice.recipient_mode !== 'gift') {
      throw new Error('Ce lien ne correspond pas à un cadeau');
    }
    if (invoice.status !== 'delivered' || !invoice.vip_key_value) {
      throw new Error('La clé cadeau n\'est pas encore disponible');
    }

    if (invoice.gift_sealed) {
      await connection.execute(
        `UPDATE vip_invoices
          SET gift_sealed = 0,
              gift_unsealed_at = COALESCE(gift_unsealed_at, NOW()),
              gift_unseal_count = gift_unseal_count + 1,
              gift_unsealed_by_ip_hash = COALESCE(gift_unsealed_by_ip_hash, ?),
              updated_at = NOW()
          WHERE id = ?`,
        [hashIp(ipAddress), invoice.id]
      );

      await logVipInvoiceEvent(
        connection,
        invoice.id,
        'gift_unsealed',
        'Cadeau descellé.',
        {
          giftToken,
          ipHash: hashIp(ipAddress)
        },
        'gift',
        giftToken
      );
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  return fetchInvoiceByGiftToken(pool, giftToken);
}

async function ensureColumnExists(pool, tableName, columnName, definitionSql) {
  const [rows] = await pool.execute(
    `SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
      LIMIT 1`,
    [tableName, columnName]
  );

  if (rows.length === 0) {
    await pool.execute(`ALTER TABLE \`${tableName}\` ADD COLUMN ${definitionSql}`);
  }
}

async function ensureIndexExists(pool, tableName, indexName, definitionSql) {
  const [rows] = await pool.execute(
    `SELECT INDEX_NAME
      FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND INDEX_NAME = ?
      LIMIT 1`,
    [tableName, indexName]
  );

  if (rows.length === 0) {
    await pool.execute(`ALTER TABLE \`${tableName}\` ADD ${definitionSql}`);
  }
}

async function ensureVipDonationsTables(pool) {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS vip_derivation_counters (
      coin ENUM('btc', 'ltc') PRIMARY KEY,
      next_index INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS vip_invoices (
      id INT AUTO_INCREMENT PRIMARY KEY,
      public_id VARCHAR(64) NOT NULL UNIQUE,
      payment_method ENUM('btc', 'ltc', 'paygate_hosted') NOT NULL,
      status ENUM('awaiting_payment', 'partial_payment', 'confirming', 'paid', 'delivered', 'expired', 'cancelled') NOT NULL DEFAULT 'awaiting_payment',
      coin ENUM('btc', 'ltc') DEFAULT NULL,
      pack_eur DECIMAL(10,2) NOT NULL,
      amount_eur DECIMAL(10,2) NOT NULL,
      amount_usd DECIMAL(10,2) NOT NULL,
      amount_crypto_expected DECIMAL(20,8) NOT NULL,
      amount_crypto_received DECIMAL(20,8) NOT NULL DEFAULT 0,
      vip_years DECIMAL(5,2) NOT NULL,
      recipient_mode ENUM('self', 'gift') NOT NULL,
      payment_address VARCHAR(128) NOT NULL,
      address_type VARCHAR(32) DEFAULT NULL,
      derivation_index INT NOT NULL,
      confirmations INT NOT NULL DEFAULT 0,
      required_confirmations INT NOT NULL DEFAULT 1,
      tx_hash VARCHAR(128) DEFAULT NULL,
      qr_payload TEXT NOT NULL,
      gift_token VARCHAR(64) DEFAULT NULL UNIQUE,
      gift_sealed TINYINT(1) NOT NULL DEFAULT 1,
      gift_unsealed_at DATETIME DEFAULT NULL,
      gift_unseal_count INT NOT NULL DEFAULT 0,
      gift_unsealed_by_ip_hash VARCHAR(128) DEFAULT NULL,
      vip_key_value VARCHAR(255) DEFAULT NULL,
      created_by_user_id VARCHAR(255) DEFAULT NULL,
      created_by_user_type VARCHAR(32) DEFAULT NULL,
      created_by_session_id VARCHAR(255) DEFAULT NULL,
      created_ip_hash VARCHAR(128) DEFAULT NULL,
      expires_at DATETIME NOT NULL,
      paid_at DATETIME DEFAULT NULL,
      delivered_at DATETIME DEFAULT NULL,
      next_check_at DATETIME DEFAULT NULL,
      paygate_tracking_address VARCHAR(255) DEFAULT NULL,
      paygate_temporary_wallet_address VARCHAR(255) DEFAULT NULL,
      paygate_callback_url TEXT DEFAULT NULL,
      paygate_callback_nonce VARCHAR(128) DEFAULT NULL,
      paygate_checkout_url TEXT DEFAULT NULL,
      paygate_payer_email VARCHAR(255) DEFAULT NULL,
      paygate_paid_coin VARCHAR(64) DEFAULT NULL,
      paygate_paid_value DECIMAL(18,8) DEFAULT NULL,
      paygate_paid_txid VARCHAR(255) DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_vip_invoices_payment_method (payment_method),
      INDEX idx_vip_invoices_status (status),
      INDEX idx_vip_invoices_coin (coin),
      INDEX idx_vip_invoices_created_at (created_at),
      INDEX idx_vip_invoices_payment_address (payment_address),
      INDEX idx_vip_invoices_vip_key (vip_key_value),
      INDEX idx_vip_invoices_paygate_paid_txid (paygate_paid_txid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS vip_invoice_events (
      id INT AUTO_INCREMENT PRIMARY KEY,
      invoice_id INT NOT NULL,
      event_type VARCHAR(64) NOT NULL,
      actor_type VARCHAR(32) DEFAULT NULL,
      actor_id VARCHAR(255) DEFAULT NULL,
      message VARCHAR(255) DEFAULT NULL,
      payload_json LONGTEXT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_vip_invoice_events_invoice (invoice_id),
      INDEX idx_vip_invoice_events_type (event_type),
      CONSTRAINT fk_vip_invoice_events_invoice
        FOREIGN KEY (invoice_id) REFERENCES vip_invoices(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.execute(
    `INSERT IGNORE INTO vip_derivation_counters (coin, next_index, created_at, updated_at)
      VALUES ('btc', 0, NOW(), NOW()), ('ltc', 0, NOW(), NOW())`
  );

  await ensureColumnExists(
    pool,
    'vip_invoices',
    'payment_method',
    "`payment_method` ENUM('btc', 'ltc', 'paygate_hosted') NULL AFTER `public_id`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'paygate_tracking_address',
    "`paygate_tracking_address` VARCHAR(255) DEFAULT NULL AFTER `next_check_at`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'paygate_temporary_wallet_address',
    "`paygate_temporary_wallet_address` VARCHAR(255) DEFAULT NULL AFTER `paygate_tracking_address`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'paygate_callback_url',
    "`paygate_callback_url` TEXT DEFAULT NULL AFTER `paygate_temporary_wallet_address`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'paygate_callback_nonce',
    "`paygate_callback_nonce` VARCHAR(128) DEFAULT NULL AFTER `paygate_callback_url`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'paygate_checkout_url',
    "`paygate_checkout_url` TEXT DEFAULT NULL AFTER `paygate_callback_nonce`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'paygate_payer_email',
    "`paygate_payer_email` VARCHAR(255) DEFAULT NULL AFTER `paygate_checkout_url`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'paygate_paid_coin',
    "`paygate_paid_coin` VARCHAR(64) DEFAULT NULL AFTER `paygate_payer_email`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'paygate_paid_value',
    "`paygate_paid_value` DECIMAL(18,8) DEFAULT NULL AFTER `paygate_paid_coin`"
  );
  await ensureColumnExists(
    pool,
    'vip_invoices',
    'paygate_paid_txid',
    "`paygate_paid_txid` VARCHAR(255) DEFAULT NULL AFTER `paygate_paid_value`"
  );

  await pool.execute(`
    UPDATE vip_invoices
    SET payment_method = coin
    WHERE payment_method IS NULL AND coin IS NOT NULL
  `);

  await pool.execute(`
    ALTER TABLE vip_invoices
    MODIFY COLUMN vip_years DECIMAL(5,2) NOT NULL
  `);
  await pool.execute(`
    ALTER TABLE vip_invoices
    MODIFY COLUMN payment_method ENUM('btc', 'ltc', 'paygate_hosted') NOT NULL
  `);
  await pool.execute(`
    ALTER TABLE vip_invoices
    MODIFY COLUMN coin ENUM('btc', 'ltc') NULL
  `);

  await ensureIndexExists(
    pool,
    'vip_invoices',
    'idx_vip_invoices_payment_method',
    'INDEX `idx_vip_invoices_payment_method` (`payment_method`)'
  );
  await ensureIndexExists(
    pool,
    'vip_invoices',
    'idx_vip_invoices_paygate_paid_txid',
    'INDEX `idx_vip_invoices_paygate_paid_txid` (`paygate_paid_txid`)'
  );
}

module.exports = {
  VIP_PACKS,
  STATUS_REASONS,
  DEFAULT_EXPIRATION_MINUTES,
  createVipInvoice,
  handlePaygateCallback,
  fetchInvoiceByPublicId,
  fetchInvoiceById,
  fetchInvoiceByGiftToken,
  refreshInvoiceStatus,
  forceValidateInvoice,
  cancelInvoice,
  getVipInvoiceDetails,
  listVipInvoices,
  serializePublicInvoice,
  serializeAdminInvoice,
  serializeGift,
  unsealGift,
  ensureVipDonationsTables,
  getClientIp,
  getSupportTelegramUrl,
  parseNumber,
  roundCrypto,
  roundFiat,
  resolvePack,
  normalizePaymentMethod,
  normalizeCoin,
  normalizeRecipientMode,
  buildPricingSnapshot,
  reserveDerivationIndex,
  derivePaymentAddress,
  buildQrPayload,
  logVipInvoiceEvent,
  deliverInvoiceIfReady,
  determineInvoiceStatus,
  fetchAddressActivity,
  getRequiredConfirmations,
  hashIp,
  safeJsonParse,
  buildDurationLabel,
  toSqlDateTime,
  fromSqlDateTime,
  buildFrontendUrl,
  getInvoicePath,
  getGiftPath
};
