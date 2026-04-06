const VIP_INVOICE_HISTORY_KEY = 'vip_invoice_history_v1';
const MAX_HISTORY_ITEMS = 30;

function readStoredHistory(): string[] {
  try {
    const rawValue = localStorage.getItem(VIP_INVOICE_HISTORY_KEY);
    if (!rawValue) {
      return [];
    }

    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function writeStoredHistory(items: string[]) {
  try {
    localStorage.setItem(VIP_INVOICE_HISTORY_KEY, JSON.stringify(items.slice(0, MAX_HISTORY_ITEMS)));
  } catch {
    // Ignore localStorage write failures.
  }
}

export function getStoredVipInvoiceHistory(): string[] {
  return readStoredHistory();
}

export function rememberVipInvoice(publicId: string) {
  const normalizedPublicId = String(publicId || '').trim();
  if (!normalizedPublicId) {
    return;
  }

  const history = readStoredHistory().filter((value) => value !== normalizedPublicId);
  history.unshift(normalizedPublicId);
  writeStoredHistory(history);
}

export function pruneVipInvoiceHistory(validPublicIds: string[]) {
  const normalizedSet = new Set(
    validPublicIds
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  );

  const filteredHistory = readStoredHistory().filter((value) => normalizedSet.has(value));
  writeStoredHistory(filteredHistory);
}
