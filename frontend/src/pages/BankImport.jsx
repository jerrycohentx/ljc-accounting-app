/**
 * Bank Import Page Component
 * ===========================
 *
 * Provides OFX file upload and transaction preview/import workflow.
 *
 * Features:
 * - Drag & drop or file picker upload
 * - Transaction preview with validation
 * - Duplicate detection
 * - Confirm import to create draft journal entries
 * - Recent imports list
 *
 * Workflow:
 * 1. Upload OFX file
 * 2. Preview transactions
 * 3. Review for duplicates/errors
 * 4. Confirm import
 * 5. Transactions appear in Journals (DRAFT status)
 * 6. User reviews and posts to ledger
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { usePlaidLink } from 'react-plaid-link';
import './BankImport.css';
import api, { plaidAPI } from '../services/api';

const BankImport = () => {
  // State
  const [selectedEntity, setSelectedEntity] = useState('ent-ljc');
  const [entities, setEntities] = useState([]);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [importSession, setImportSession] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [recentImports, setRecentImports] = useState([]);
  const [sortColumn, setSortColumn] = useState('date');
  const [sortDir, setSortDir] = useState('desc');
  const [plaidConfigured, setPlaidConfigured] = useState(false);
  const [plaidLinkToken, setPlaidLinkToken] = useState(null);
  const [linkedBanks, setLinkedBanks] = useState([]);
  const [plaidSource, setPlaidSource] = useState(false);
  const fileInputRef = useRef(null);

  // Load entities on mount
  React.useEffect(() => {
    loadEntities();
    loadRecentImports();
    loadPlaidStatus();
  }, []);

  React.useEffect(() => {
    if (selectedEntity) {
      loadLinkedBanks();
    }
  }, [selectedEntity]);

  const loadPlaidStatus = async () => {
    try {
      const response = await plaidAPI.status();
      setPlaidConfigured(response.data.configured);
    } catch (err) {
      setPlaidConfigured(false);
    }
  };

  const loadLinkedBanks = async () => {
    if (!selectedEntity) return;
    try {
      const response = await plaidAPI.listItems(selectedEntity);
      setLinkedBanks(response.data);
    } catch (err) {
      setLinkedBanks([]);
    }
  };

  const handlePlaidSuccess = async (publicToken, metadata) => {
    const institution = metadata?.institution;
    const instName = (institution?.name || '').toLowerCase();

    if (/lone\s*star|lonestar/.test(instName)) {
      setError(
        'Lone Star Bank cannot be connected through Plaid. Only Simmons Bank and American Express are supported for automatic feeds. Use OFX upload for Lone Star Bank.'
      );
      setPlaidLinkToken(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await plaidAPI.exchangePublicToken(selectedEntity, publicToken, institution);
      setSuccess(`${institution?.name || 'Bank'} connected successfully.`);
      setPlaidLinkToken(null);
      await loadLinkedBanks();
    } catch (err) {
      setError(err.response?.data?.error || `Failed to link ${institution?.name || 'bank'}`);
    } finally {
      setLoading(false);
    }
  };

  const { open: openPlaidLink, ready: plaidReady } = usePlaidLink({
    token: plaidLinkToken,
    onSuccess: handlePlaidSuccess,
    onExit: () => setPlaidLinkToken(null),
  });

  React.useEffect(() => {
    if (plaidLinkToken && plaidReady) {
      openPlaidLink();
    }
  }, [plaidLinkToken, plaidReady, openPlaidLink]);

  const handleConnectSimmonsBank = async () => {
    if (!selectedEntity) {
      setError('Please select an entity');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await plaidAPI.createLinkToken(selectedEntity);
      setPlaidLinkToken(response.data.linkToken);
    } catch (err) {
      setError(err.response?.data?.error || 'Plaid is not available. Add API keys on the server.');
    } finally {
      setLoading(false);
    }
  };

  const handlePlaidSync = async (itemId) => {
    setLoading(true);
    setError(null);
    setPlaidSource(true);
    try {
      const response = await plaidAPI.sync(selectedEntity, itemId);
      setImportSession(response.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to sync from Plaid');
      setImportSession(null);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Load available entities
   */
  const loadEntities = async () => {
    try {
      const response = await api.get('/api/entities');
      setEntities(response.data);
    } catch (err) {
      console.error('Failed to load entities:', err);
    }
  };

  /**
   * Load recent import sessions
   */
  const loadRecentImports = async () => {
    try {
      const response = await api.get('/api/import/list');
      const sorted = response.data.sort((a, b) =>
        new Date(b.createdAt) - new Date(a.createdAt)
      );
      setRecentImports(sorted.slice(0, 10));
    } catch (err) {
      console.error('Failed to load recent imports:', err);
    }
  };

  /**
   * Handle file selection from input
   */
  const handleFileSelect = (event) => {
    const file = event.target.files?.[0];
    if (file) {
      handleFileUpload(file);
    }
  };

  /**
   * Handle file upload (drag & drop or file picker)
   */
  const handleFileUpload = async (file) => {
    if (!selectedEntity) {
      setError('Please select an entity');
      return;
    }

    if (!file.name.toLowerCase().endsWith('.ofx')) {
      setError('File must be OFX format (.ofx)');
      return;
    }

    if (file.size > 50 * 1024 * 1024) {
      setError('File too large (max 50MB)');
      return;
    }

    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      // Read file as text
      const fileContent = await readFileAsText(file);

      // Send to server for parsing
      const response = await api.post('/api/import/ofx', {
        ofxContent: fileContent,
        fileName: file.name,
        entityId: selectedEntity
      });

      // Store import session
      setImportSession(response.data);
      setPlaidSource(false);
      setUploadProgress(100);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to parse OFX file');
      setImportSession(null);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Read file as text
   */
  const readFileAsText = (file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = (e) => reject(e);
      reader.readAsText(file);
    });
  };

  /**
   * Confirm import and create draft journal entries
   */
  const handleConfirmImport = async () => {
    if (!importSession?.importId) {
      setError('Invalid import session');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = plaidSource
        ? await plaidAPI.import(importSession.importId)
        : await api.post('/api/import/transactions', {
            importId: importSession.importId,
            accountMappings: {},
          });

      setSuccess(
        `Successfully imported ${response.data.transactionsProcessed} transactions. ` +
        `They are now in DRAFT status. Go to Journals to review and post.`
      );

      // Clear session
      setImportSession(null);
      setPlaidSource(false);

      // Reload recent imports
      loadRecentImports();

      // Clear file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to import transactions');
    } finally {
      setLoading(false);
    }
  };

  /**
   * Handle drag over
   */
  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  /**
   * Handle drop
   */
  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();

    const files = e.dataTransfer.files;
    if (files?.length > 0) {
      handleFileUpload(files[0]);
    }
  };

  /**
   * Format currency
   */
  const formatCurrency = (value) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD'
    }).format(value);
  };

  /**
   * Format date
   */
  const formatDate = (dateStr) => {
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  };

  return (
    <div className="bank-import-container">
      <div className="import-header">
        <h1>Bank Import</h1>
        <p>Connect Simmons Bank or American Express with Plaid, or upload OFX files, to import transactions as draft journal entries</p>
      </div>

      {error && (
        <div className="alert alert-error">
          <span className="alert-icon">!</span>
          <span className="alert-text">{error}</span>
          <button className="alert-close" onClick={() => setError(null)}>×</button>
        </div>
      )}

      {success && (
        <div className="alert alert-success">
          <span className="alert-icon">✓</span>
          <span className="alert-text">{success}</span>
          <button className="alert-close" onClick={() => setSuccess(null)}>×</button>
        </div>
      )}

      <div className="import-main">
        {/* Left Panel: Upload Section */}
        <div className="import-upload-section">
          <div className="entity-selector">
            <label>Select Entity</label>
            <select
              value={selectedEntity}
              onChange={(e) => setSelectedEntity(e.target.value)}
              disabled={loading || importSession != null}
            >
              {entities.map(entity => (
                <option key={entity.id} value={entity.id}>
                  {entity.name} ({entity.code})
                </option>
              ))}
            </select>
          </div>

          {plaidConfigured && (
            <div className="plaid-section">
              <h3>Connect Bank Account (Plaid)</h3>
              <p className="upload-hint">
                Automatic Simmons Bank and American Express feeds. Lone Star Bank and other banks — use OFX upload below.
              </p>
              <button
                type="button"
                className="btn-primary"
                onClick={handleConnectSimmonsBank}
                disabled={loading || importSession != null}
              >
                Connect Bank Account
              </button>
              {linkedBanks.length > 0 && (
                <ul className="linked-banks-list">
                  {linkedBanks.map((bank) => (
                    <li key={bank.item_id}>
                      <span>{bank.institution_name || 'Bank'}</span>
                      <button
                        type="button"
                        className="btn-secondary btn-small"
                        onClick={() => handlePlaidSync(bank.item_id)}
                        disabled={loading || importSession != null}
                      >
                        Sync {bank.institution_name || 'Bank'}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div
            className="upload-area"
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".ofx"
              onChange={handleFileSelect}
              style={{ display: 'none' }}
              disabled={loading}
            />

            {!importSession && !loading && (
              <>
                <div className="upload-icon">📄</div>
                <h3>Upload OFX File</h3>
                <p>Drag and drop your OFX file here, or click to browse</p>
                <p className="upload-hint">Supported format: .ofx (Web Connect)</p>
              </>
            )}

            {loading && (
              <>
                <div className="loading-spinner"></div>
                <p>Parsing OFX file...</p>
                {uploadProgress > 0 && (
                  <div className="progress-bar">
                    <div
                      className="progress-fill"
                      style={{ width: `${uploadProgress}%` }}
                    ></div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Right Panel: Preview Section */}
        {importSession && (
          <div className="import-preview-section">
            <div className="preview-header">
              <h2>Import Preview</h2>
              <button
                className="btn-secondary"
                onClick={() => {
                  setImportSession(null);
                  setPlaidSource(false);
                }}
                disabled={loading}
              >
                ← Back
              </button>
            </div>

            <div className="preview-info">
              <div className="info-group">
                <label>File</label>
                <value>{importSession.fileName}</value>
              </div>

              <div className="info-group">
                <label>Date Range</label>
                <value>
                  {importSession.dateRange?.start} to {importSession.dateRange?.end}
                </value>
              </div>

              <div className="info-group">
                <label>Account</label>
                <value>{importSession.accountId || 'Unknown'}</value>
              </div>

              <div className="info-group">
                <label>Type</label>
                <value>{importSession.statementType}</value>
              </div>
            </div>

            <div className="preview-stats">
              <div className="stat">
                <div className="stat-value">{importSession.summary.totalTransactions}</div>
                <div className="stat-label">Total Transactions</div>
              </div>
              <div className="stat stat-new">
                <div className="stat-value">{importSession.summary.newTransactions}</div>
                <div className="stat-label">New</div>
              </div>
              <div className="stat stat-duplicate">
                <div className="stat-value">{importSession.summary.duplicateTransactions}</div>
                <div className="stat-label">Duplicates</div>
              </div>
            </div>

            {importSession.validation && !importSession.validation.valid && (
              <div className="validation-warnings">
                <h4>Validation Issues</h4>
                {importSession.validation.issues.map((issue, i) => (
                  <div key={i} className="warning">{issue}</div>
                ))}
              </div>
            )}

            <div className="preview-transactions">
              <h4>Sample Transactions (first 10)</h4>
              <table className="transactions-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Description</th>
                    <th>Type</th>
                    <th>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {importSession.preview?.map((txn, i) => (
                    <tr key={i}>
                      <td>{formatDate(txn.date)}</td>
                      <td className="desc">{txn.description}</td>
                      <td><span className="type-badge">{txn.type}</span></td>
                      <td className={txn.isCredit ? 'credit' : 'debit'}>
                        {txn.isCredit ? '+' : '-'}{formatCurrency(Math.abs(txn.amount))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="preview-actions">
              <button
                className="btn-primary"
                onClick={handleConfirmImport}
                disabled={loading || importSession.validation?.issues?.length > 0}
              >
                {loading ? 'Importing...' : 'Confirm Import'}
              </button>
              <p className="import-note">
                Transactions will be created as DRAFT journal entries.
                Review them in Journals before posting to ledger.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Recent Imports Section */}
      <div className="recent-imports-section">
        <h2>Recent Imports</h2>
        {recentImports.length === 0 ? (
          <p className="empty-state">No recent imports. Upload an OFX file to get started.</p>
        ) : (
          <table className="imports-table">
            <thead>
              <tr>
                <th onClick={() => setSortColumn('fileName')}>
                  File {sortColumn === 'fileName' && (sortDir === 'asc' ? '▲' : '▼')}
                </th>
                <th>Date Range</th>
                <th>Transactions</th>
                <th>Status</th>
                <th>Imported</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {recentImports.map(imp => (
                <tr key={imp.importId}>
                  <td>{imp.fileName}</td>
                  <td>
                    {imp.dateRange?.start} to {imp.dateRange?.end}
                  </td>
                  <td>{imp.summary.totalTransactions}</td>
                  <td>
                    <span className={`status status-${imp.status.toLowerCase()}`}>
                      {imp.status}
                    </span>
                  </td>
                  <td>{imp.summary.imported} / {imp.summary.newTransactions}</td>
                  <td>
                    <button className="btn-small">View</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

export default BankImport;
