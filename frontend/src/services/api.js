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

// Handle token expiry
client.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export const authAPI = {
  login: (email, password) => client.post('/auth/login', { email, password }),
  register: (email, password, fullName) => client.post('/auth/register', { email, password, fullName }),
  refresh: (token) => client.post('/auth/refresh', { token })
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
  post: (entityId, id) => client.post(`/api/entities/${entityId}/journals/${id}/post`)
};

export const reportAPI = {
  balanceSheet: (entityId, asOfDate) => client.get(`/api/entities/${entityId}/reports/balance-sheet`, { params: { asOfDate } }),
  incomeStatement: (entityId, startDate, endDate) => client.get(`/api/entities/${entityId}/reports/income-statement`, { params: { startDate, endDate } }),
  dashboard: (entityId) => client.get(`/api/entities/${entityId}/reports/dashboard`),
  accountBalances: (entityId, asOfDate, accountType) => client.get(`/api/entities/${entityId}/reports/account-balances`, { params: { asOfDate, accountType } }),
  cashFlow: (entityId, startDate, endDate) => client.get(`/api/entities/${entityId}/reports/cash-flow`, { params: { startDate, endDate } }),
  generalLedger: (entityId, accountId, startDate, endDate) => client.get(`/api/entities/${entityId}/ledger/account/${accountId}`, { params: { startDate, endDate } }),
  trialBalance: (entityId, asOfDate) => client.get(`/api/entities/${entityId}/reports/trial-balance`, { params: { asOfDate } }),
  ledgerAll: (entityId, startDate, endDate, limit = 1000) => client.get(`/api/entities/${entityId}/ledger`, { params: { startDate, endDate, limit } })
};

export const bankReconAPI = {
  worksheet: (entityId, accountId, statementDate) => client.get('/api/reconciliation/bank/worksheet', { params: { entityId, accountId, statementDate } }),
  reconcile: (data) => client.post('/api/reconciliation/bank/reconcile', data)
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
  setAccount: (fitid, entityId, offsetAccountId) =>
    client.patch(`/api/import/pending/${fitid}`, { entityId, offsetAccountId }),
  postSelected: (entityId, jeIds) => client.post('/api/import/post-selected', { entityId, jeIds }),
  reject: (entityId, fitids) => client.post('/api/import/reject', { entityId, fitids }),
};

export const gmailAPI = {
  status: () => client.get('/api/email/gmail/status'),
  authUrl: (user) => client.get('/api/email/gmail/auth-url', { params: user ? { user } : {} }),
  disconnect: () => client.post('/api/email/gmail/disconnect'),
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
