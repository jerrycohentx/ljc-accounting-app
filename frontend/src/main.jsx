import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

/** Loan Tracker opens Cohen Accounting with ?ltToken=… — store before React auth gate. */
(function applyLoanTrackerHandoff() {
  try {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('ltToken');
    if (!token) return;
    localStorage.setItem('token', token);
    const entityId = params.get('ltEntity');
    if (entityId) localStorage.setItem('entityId', entityId);
    const userJson = params.get('ltUser');
    if (userJson) {
      try { localStorage.setItem('user', decodeURIComponent(userJson)); } catch (_) { /* ignore */ }
    }
    params.delete('ltToken');
    params.delete('ltEntity');
    params.delete('ltUser');
    const qs = params.toString();
    const clean = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash;
    window.history.replaceState({}, '', clean);
  } catch (_) { /* ignore */ }
})();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
