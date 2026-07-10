import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_URL || '';

const client = axios.create({
  baseURL: API_BASE,
  headers: { 'Content-Type': 'application/json' }
});

// Add token to requests
client.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Handle token expiry — do not hard-reload on /login (that resets the form to demo defaults)
client.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 401) {
      const url = String(error.config?.url || '');
      if (url.includes('/auth/login') || url.includes('/auth/register')) {
        return Promise.reject(error);
      }
      const path = window.location.pathname || '';
      const onLoginPage = path === '/login' || path.endsWith('/login');
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      if (!onLoginPage) {
        try {
          sessionStorage.setItem('ljc_session_expired', '1');
        } catch {
          /* ignore */
        }
        window.location.assign('/login');
      }
    }
    return Promise.reject(error);
  }
);

export const authAPI = {
  login: (email, password) => client.post('/auth/login', {
    email: String(email || '').trim().toLowerCase(),
    password,
  }),
  register: (email, password, fullName) => client.post('/auth/register', { email, password, fullName }),
  refresh: (token) => client.post('/auth/refresh', { token }),
  forgotPasswordRequest: (email) => client.post('/auth/forgot-password/request', { email }),
  forgotPasswordReset: (email, code, newPassword) =>
    client.post('/auth/forgot-password/reset', { email, code, newPassword }),
};

export const entityAPI = {
  list: () => client.get('/api/entities'),
  get: (id) => client.get(`/api/entities/${id}`),
  create: (data) => client.post('/api/entities', data),
  update: (id, data) => client.put(`/api/entities/${id}`, data)
};

export const accountAPI = {
  list: (entityId) => client.get(`/api/entities/${entityId}/accounts`),
  get: (entityId, id) => client.get(`/api/entities/${entityId}/accounts/${id}`),
  create: (entityId, data) => client.post(`/api/entities/${entityId}/accounts`, data),
  update: (entityId, id, data) => client.put(`/api/entities/${entityId}/accounts/${id}`, data)
};

export const journalAPI = {
  list: (entityId, params) => client.get(`/api/entities/${entityId}/journals`, { params }),
  get: (entityId, id) => client.get(`/api/entities/${entityId}/journals/${id}`),
  create: (entityId, data) => client.post(`/api/entities/${entityId}/journals`, data),
  update: (entityId, id, data) => client.put(`/api/entities/${entityId}/journals/${id}`, data),
  approve: (entityId, id) => client.post(`/api/entities/${entityId}/journals/${id}/approve`),
  post: (entityId, id) => client.post(`/api/entities/${entityId}/journals/${id}/post`),
  reverse: (entityId, id, data) => client.post(`/api/entities/${entityId}/journals/${id}/reverse`, data),
  async viewDocument(entityId, id) {
    const token = localStorage.getItem('token');
    const res = await fetch(`/api/entities/${entityId}/journals/${id}/document`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new Error('Could not load the attached document');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
};

export const reportAPI = {
  balanceSheet: (entityId, asOfDate) => client.get(`/api/entities/${entityId}/reports/balance-sheet`, { params: { asOfDate } }),
  incomeStatement: (entityId, startDate, endDate) => client.get(`/api/entities/${entityId}/reports/income-statement`, { params: { startDate, endDate } }),
  dashboard: (entityId) => client.get(`/api/entities/${entityId}/reports/dashboard`),
  accountBalances: (entityId, asOfDate, accountType) => client.get(`/api/entities/${entityId}/reports/account-balances`, { params: { asOfDate, accountType } }),
  cashFlow: (entityId, startDate, endDate) => client.get(`/api/entities/${entityId}/reports/cash-flow`, { params: { startDate, endDate } }),
  generalLedger: (entityId, accountId, startDate, endDate) => client.get(`/api/entities/${entityId}/ledger/account/${accountId}`, { params: { startDate, endDate } }),
  trialBalance: (entityId, asOfDate) => client.get(`/api/entities/${entityId}/reports/trial-balance`, { params: { asOfDate } }),
  ledgerAll: (entityId, startDate, endDate, limit = 1000) => client.get(`/api/entities/${entityId}/ledger`, { params: { startDate, endDate, limit } }),
  comparison: (entityId, params) => client.get(`/api/entities/${entityId}/reports/comparison`, { params }),
  kpiDashboard: (entityId, params) => client.get(`/api/entities/${entityId}/reports/kpi-dashboard`, { params }),
  segments: (entityId) => client.get(`/api/entities/${entityId}/reports/segments`),
  benchmarkTargets: (entityId, segment) => client.get(`/api/entities/${entityId}/reports/benchmark-targets`, { params: { segment } }),
};

export const bankReconAPI = {
  prepare: (entityId, accountId, statementDate) => client.get('/api/reconciliation/bank/prepare', {
    params: { entityId, accountId, statementDate },
  }),
  worksheet: (entityId, accountId, statementDate, opts = {}) => client.get('/api/reconciliation/bank/worksheet', {
    params: {
      entityId,
      accountId,
      statementDate,
      autoMatch: opts.autoMatch ? '1' : undefined,
    },
  }),
  reconcile: (data) => client.post('/api/reconciliation/bank/reconcile', data),
  reopen: (data) => client.post('/api/reconciliation/bank/reopen', data),
  importStatement: (data) => client.post('/api/reconciliation/bank/import-statement', data),
  adjustment: (data) => client.post('/api/reconciliation/bank/adjustment', data),
};

export const reconReportAPI = {
  list: (entityId, accountId) => client.get('/api/reconciliation/reports', {
    params: { entityId, accountId: accountId || undefined },
  }),
  get: (id) => client.get(`/api/reconciliation/reports/${id}`),
  // Fetch the on-demand PDF (summary | detail | both) and save it. Uses fetch so
  // the Bearer token is attached; a plain <a href> would not authenticate.
  async downloadPdf(id, mode, filename) {
    const token = localStorage.getItem('token');
    const res = await fetch(`/api/reconciliation/reports/${id}/pdf?mode=${mode}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error('Could not generate the reconciliation PDF');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  },
};

export const backupAPI = {
  status: () => client.get('/api/backup/status'),
  list: (limit = 20) => client.get('/api/backup/list', { params: { limit } }),
  run: () => client.post('/api/backup/run'),
  download: (id) => client.get(`/api/backup/download/${id}`, { responseType: 'blob' }),
};

export const taxAPI = {
  allEntities: (taxYear) => client.get(`/api/tax-financials/${taxYear}`),
  entity: (entityId, taxYear) => client.get(`/api/entities/${entityId}/tax-financials/${taxYear}`),
  exportAllUrl: (taxYear) => `/api/tax-financials/${taxYear}/export.csv`,
  exportEntityUrl: (entityId, taxYear) => `/api/entities/${entityId}/tax-financials/${taxYear}/export.csv`,
  async downloadCsv(url, filename) {
    const token = localStorage.getItem('token');
    const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new Error('Export failed');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  },
};

export default client;

export const plaidAPI = {
  status: () => client.get('/api/plaid/status'),
  createLinkToken: (entityId, options = {}) =>
    client.post('/api/plaid/create-link-token', { entityId, ...options }),
  exchangePublicToken: (entityId, publicToken, institution) =>
    client.post('/api/plaid/exchange-public-token', { entityId, publicToken, institution }),
  listItems: (entityId) => client.get('/api/plaid/items', { params: { entityId } }),
  sync: (entityId, itemId, options = {}) => client.post('/api/plaid/sync', { entityId, itemId, ...options }),
  import: (importId, draft = false) => client.post('/api/plaid/import', { importId, draft }),
  disconnect: (entityId, itemId, options = {}) =>
    client.post('/api/plaid/disconnect', { entityId, itemId, ...options }),
  sandboxPurgeImports: (entityId) =>
    client.post('/api/plaid/sandbox-purge-imports', { entityId }),
  sandboxConnectTestBank: (entityId) =>
    client.post('/api/plaid/sandbox-connect-test-bank', { entityId }),
  sandboxAutoSetup: (entityId, options = {}) =>
    client.post('/api/plaid/sandbox-auto-setup', { entityId, ...options }),
  sandboxConnectInstitution: (entityId, institutionKey, options = {}) =>
    client.post('/api/plaid/sandbox-connect-institution', { entityId, institutionKey, ...options }),
};

export const importAPI = {
  pending: (entityId) => client.get('/api/import/pending', { params: { entityId } }),
  pendingCount: (entityId) => client.get('/api/import/pending-count', { params: entityId ? { entityId } : {} }),
  reviewQueue: (params = {}) => client.get('/api/import/review-queue', { params }),
  setAccount: (fitid, entityId, offsetAccountId) =>
    client.patch(`/api/import/pending/${fitid}`, { entityId, offsetAccountId }),
  postSelected: (entityId, jeIds) => client.post('/api/import/post-selected', { entityId, jeIds }),
  reject: (entityId, fitids) => client.post('/api/import/reject', { entityId, fitids }),
  reapplyRules: (entityId) => client.post('/api/import/reapply-rules', { entityId }),
};

export const feedsAPI = {
  status: () => client.get('/api/feeds/status'),
};

export const dashboardAPI = {
  entitiesSummary: () => client.get('/api/dashboard/entities-summary'),
};

export const achJeAPI = {
  preview: (data) => client.post('/api/ach-je-import/preview', data),
  commit: (data) => client.post('/api/ach-je-import/commit', data),
};

export const receiptAPI = {
  providers: () => client.get('/api/receipts/providers'),
  listConnections: (entityId) => client.get('/api/receipts/connections', { params: { entityId } }),
  connect: (data) => client.post('/api/receipts/connections', data),
  disconnect: (id) => client.delete(`/api/receipts/connections/${id}`),
  scan: (entityId, connectionId) => client.post('/api/receipts/scan', { entityId, connectionId }),
  upload: (data) => client.post('/api/receipts/upload', data),
  list: (entityId, status) => client.get('/api/receipts', { params: { entityId, status } }),
  stats: (entityId) => client.get('/api/receipts/stats', { params: { entityId } }),
  get: (id) => client.get(`/api/receipts/${id}`),
  update: (id, data) => client.patch(`/api/receipts/${id}`, data),
  approve: (id) => client.post(`/api/receipts/${id}/approve`),
  reject: (id) => client.delete(`/api/receipts/${id}`),
  post: (id) => client.post(`/api/receipts/${id}/post`),
  sync: (id, connectionId) => client.post(`/api/receipts/${id}/sync`, { connectionId }),
  exportUrl: (entityId, status) => {
    const params = new URLSearchParams();
    if (entityId) params.set('entityId', entityId);
    if (status) params.set('status', status);
    return `/api/receipts/export?${params.toString()}`;
  },
};

export const mgmtReportAPI = {
  list: (entityId, status) => client.get('/api/mgmt-reports', { params: { entityId, status } }),
  get: (id) => client.get(`/api/mgmt-reports/${id}`),
  upload: (data) => client.post('/api/mgmt-reports/upload', data),
  update: (id, data) => client.patch(`/api/mgmt-reports/${id}`, data),
  approve: (id) => client.post(`/api/mgmt-reports/${id}/approve`),
  createJournal: (id) => client.post(`/api/mgmt-reports/${id}/create-journal`),
  reject: (id) => client.delete(`/api/mgmt-reports/${id}`),
  markReceived: (id, data) => client.post(`/api/mgmt-reports/${id}/mark-received`, data),
  async viewFile(id, fileName) {
    const token = localStorage.getItem('token');
    const res = await fetch(`/api/mgmt-reports/${id}/file`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new Error('Could not load the source report');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  },
};

export const interestAPI = {
  preview: (entityId, asOfDate) =>
    client.get(`/api/entities/${entityId}/interest-accrual/preview`, { params: { asOfDate } }),
  post: (entityId, asOfDate) =>
    client.post(`/api/entities/${entityId}/interest-accrual/post`, { asOfDate }),
};

export const accountingAPI = {
  listPeriods: (entityId) => client.get(`/api/entities/${entityId}/accounting/periods`),
  closePeriod: (entityId, data) => client.post(`/api/entities/${entityId}/accounting/periods/close`, data),
  reopenPeriod: (entityId, data) => client.post(`/api/entities/${entityId}/accounting/periods/reopen`, data),
  previewOpeningBalances: (entityId, data) =>
    client.post(`/api/entities/${entityId}/accounting/opening-balances/preview`, data),
  postOpeningBalances: (entityId, data) =>
    client.post(`/api/entities/${entityId}/accounting/opening-balances`, data),
  previewYearEnd: (entityId, asOfDate) =>
    client.get(`/api/entities/${entityId}/accounting/year-end/preview`, { params: { asOfDate } }),
  postYearEnd: (entityId, data) =>
    client.post(`/api/entities/${entityId}/accounting/year-end/close`, data),
};

export const emailIngestAPI = {
  status: () => client.get('/api/email/ingest/status'),
  run: () => client.post('/api/email/ingest/run'),
  history: (limit = 20) => client.get('/api/email/ingest/history', { params: { limit } }),
};

export const gmailAPI = {
  status: () => client.get('/api/email/gmail/status'),
  authUrl: (user, label) => client.get('/api/email/gmail/auth-url', { params: { user, label } }),
  disconnect: (user) => client.post('/api/email/gmail/disconnect', { user }),
  imapConnect: (data) => client.post('/api/email/gmail/imap-connect', data),
  scanStatements: (options = {}) => client.post('/api/import/email-scan', options),
};

export const documentCaptureAPI = {
  status: () => client.get('/api/document-capture/status'),
  scan: (options = {}) => client.post('/api/document-capture/scan', options),
  list: (params = {}) => client.get('/api/document-capture/documents', { params }),
  get: (id, entityId = 'ent-ljc') =>
    client.get(`/api/document-capture/documents/${id}`, { params: { entityId } }),
  approve: (id, entityId = 'ent-ljc') =>
    client.post(`/api/document-capture/documents/${id}/approve`, { entityId }),
  reject: (id, entityId = 'ent-ljc') =>
    client.post(`/api/document-capture/documents/${id}/reject`, { entityId }),
  update: (id, data) => client.patch(`/api/document-capture/documents/${id}`, data),
  upload: (data) => client.post('/api/document-capture/upload', data),
};
