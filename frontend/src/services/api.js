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
  generalLedger: (entityId, accountId, startDate, endDate) => client.get(`/api/entities/${entityId}/ledger/account/${accountId}`, { params: { startDate, endDate } })
};

export default client;

export const plaidAPI = {
  status: () => client.get('/api/plaid/status'),
  testConnection: () => client.post('/api/plaid/test-connection'),
  createLinkToken: (entityId) => client.post('/api/plaid/create-link-token', { entityId }),
  exchangePublicToken: (entityId, publicToken, institution) =>
    client.post('/api/plaid/exchange-public-token', { entityId, publicToken, institution }),
  listItems: (entityId) => client.get('/api/plaid/items', { params: { entityId } }),
  sync: (entityId, itemId) => client.post('/api/plaid/sync', { entityId, itemId }),
  import: (importId) => client.post('/api/plaid/import', { importId }),
};
