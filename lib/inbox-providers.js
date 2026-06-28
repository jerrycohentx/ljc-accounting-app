/**
 * Inbox / Cloud / Accounting Provider Adapters
 * =============================================
 *
 * Thin abstraction over the external services WellyBox-style collection talks
 * to. Each adapter exposes a small, uniform surface so the ingestion pipeline
 * does not care which provider produced a document.
 *
 * Real integrations (Gmail/Outlook via OAuth, Drive/Dropbox, QuickBooks/Xero)
 * require provider credentials configured as environment variables. When those
 * are absent the adapter runs in deterministic SANDBOX mode so the end-to-end
 * pipeline (scan -> parse -> review -> post/export) is fully exercisable. This
 * mirrors how the bank feed falls back to sandbox behavior.
 *
 * Discovered documents use a stable external_ref so repeated scans are
 * idempotent (no duplicate receipts) per the idempotent-ingestion rule.
 */

export const EMAIL_PROVIDERS = ['GMAIL', 'OUTLOOK'];
export const CLOUD_PROVIDERS = ['GDRIVE', 'DROPBOX'];
export const ACCOUNTING_PROVIDERS = ['QUICKBOOKS', 'XERO'];
export const CAPTURE_PROVIDERS = ['WHATSAPP', 'MOBILE'];

export const SUPPORTED_PROVIDERS = [
  ...EMAIL_PROVIDERS,
  ...CLOUD_PROVIDERS,
  ...ACCOUNTING_PROVIDERS,
  ...CAPTURE_PROVIDERS,
];

const PROVIDER_LABELS = {
  GMAIL: 'Gmail',
  OUTLOOK: 'Outlook',
  GDRIVE: 'Google Drive',
  DROPBOX: 'Dropbox',
  QUICKBOOKS: 'QuickBooks Online',
  XERO: 'Xero',
  WHATSAPP: 'WhatsApp Bot',
  MOBILE: 'Mobile Scanner',
};

export function providerLabel(provider) {
  return PROVIDER_LABELS[provider] || provider;
}

export function isSupportedProvider(provider) {
  return SUPPORTED_PROVIDERS.includes(provider);
}

/**
 * Whether a real (non-sandbox) integration is configured for this provider.
 */
export function providerConfigured(provider) {
  switch (provider) {
    case 'GMAIL':
      return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
    case 'OUTLOOK':
      return Boolean(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);
    case 'GDRIVE':
      return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
    case 'DROPBOX':
      return Boolean(process.env.DROPBOX_APP_KEY && process.env.DROPBOX_APP_SECRET);
    case 'QUICKBOOKS':
      return Boolean(process.env.QBO_CLIENT_ID && process.env.QBO_CLIENT_SECRET);
    case 'XERO':
      return Boolean(process.env.XERO_CLIENT_ID && process.env.XERO_CLIENT_SECRET);
    default:
      return false;
  }
}

// Deterministic sample documents so a sandbox scan returns realistic, stable
// receipts. Re-scanning yields the same external_ref => idempotent dedupe.
const SANDBOX_DOCUMENTS = [
  {
    slug: 'aws',
    fileName: 'aws-invoice.pdf',
    fileMime: 'application/pdf',
    rawText: [
      'Amazon Web Services, Inc.',
      'Tax Invoice',
      'Invoice Date: 2024-03-01',
      'Account: acct holder support@example.com',
      'EC2 Compute            420.00',
      'S3 Storage              35.50',
      'Subtotal               455.50',
      'Tax (8.25%)             37.58',
      'Total Due            $493.08',
      'Paid with VISA ending 4242',
    ].join('\n'),
  },
  {
    slug: 'uber',
    fileName: 'uber-receipt.eml',
    fileMime: 'message/rfc822',
    rawText: [
      'Uber Technologies',
      'Receipt for your trip',
      'Date: 03/14/2024',
      'Trip fare            18.40',
      'Booking fee           2.50',
      'Subtotal             20.90',
      'Tax                   1.72',
      'Total               $22.62',
      'Rider phone (415) 555-0199',
    ].join('\n'),
  },
  {
    slug: 'staples',
    fileName: 'staples-receipt.jpg',
    fileMime: 'image/jpeg',
    rawText: [
      'STAPLES Store #1842',
      'Receipt',
      '04/02/2024',
      'Printer Paper x5      24.95',
      'Ink Cartridge         39.99',
      'Subtotal              64.94',
      'Sales Tax              5.36',
      'TOTAL                $70.30',
    ].join('\n'),
  },
];

/**
 * Discover receipt/invoice documents for a connected inbox or cloud account.
 * Returns an array of { externalRef, fileName, fileMime, rawText, receivedDate }.
 */
export async function fetchDocuments(connection) {
  const { provider, id } = connection;

  if (providerConfigured(provider)) {
    // Real provider integrations require completing the OAuth flow and calling
    // the provider's message/file APIs. Those calls belong here. Until tokens
    // are present we return an empty set rather than fabricating live data.
    return [];
  }

  // SANDBOX mode: deterministic documents keyed to the connection id.
  return SANDBOX_DOCUMENTS.map((doc) => ({
    externalRef: `${provider}:${id}:${doc.slug}`,
    fileName: doc.fileName,
    fileMime: doc.fileMime,
    rawText: doc.rawText,
    receivedDate: null,
  }));
}

/**
 * Push an already-extracted receipt to an external accounting system.
 * Returns { externalId, status }.
 */
export async function pushToAccounting(connection, receipt) {
  const { provider } = connection;
  if (!ACCOUNTING_PROVIDERS.includes(provider)) {
    throw new Error(`${providerLabel(provider)} is not an accounting destination`);
  }

  if (providerConfigured(provider)) {
    // Real push would call the QuickBooks/Xero Bill/Expense API here using the
    // connection's decrypted OAuth token.
    throw new Error(
      `${providerLabel(provider)} live sync requires completing OAuth; configure tokens to enable.`
    );
  }

  // SANDBOX: acknowledge the push deterministically.
  return {
    externalId: `${provider}-${receipt.id}`,
    status: 'SYNCED_SANDBOX',
  };
}
