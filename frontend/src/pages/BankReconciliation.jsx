/**
 * Bank Reconciliation Page Component
 * ===================================
 *
 * Provides two-column reconciliation view for matching GL to bank transactions.
 *
 * Features:
 * - Two-column layout: GL (left) vs Bank (right)
 * - Auto-match by amount and date
 * - Manual drag-and-drop matching (optional)
 * - Mark cleared/reconciled
 * - Reconciliation summary
 * - Unmatched item flagging
 *
 * Workflow:
 * 1. Select entity, account, and date range
 * 2. Auto-match GL to bank transactions
 * 3. Review unmatched items
 * 4. Clear/reconcile matched transactions
 * 5. Verify variance (should be $0)
 */

import React, { useState, useEffect } from 'react';
import './BankReconciliation.css';
import api from '../services/api';

const BankReconciliation = () => {
  // State
  const [entities, setEntities] = useState([]);
  const [selectedEntity, setSelectedEntity] = useState('ent-ljc');
  const [selectedAccount, setSelectedAccount] = useState('');
  const [accounts, setAccounts] = useState([]);
  const [asOfDate, setAsOfDate] = useState(new Date().toISOString().split('T')[0]);

  const [glEntries, setGlEntries] = useState([]);
  const [bankTransactions, setBankTransactions] = useState([]);
  const [matches, setMatches] = useState(new Map());
  const [clearing, setClearing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [summary, setSummary] = useState(null);
  const [pendingDraws, setPendingDraws] = useState([]);
  const [verifyingDraw, setVerifyingDraw] = useState(null);

  // Load entities on mount
  useEffect(() => {
    loadEntities();
  }, []);

  // Load accounts when entity changes
  useEffect(() => {
    if (selectedEntity) {
      loadAccounts(selectedEntity);
      setSelectedAccount('');
    }
  }, [selectedEntity]);

  // Load reconciliation data when account changes
  useEffect(() => {
    if (selectedEntity && selectedAccount) {
      loadReconData();
    }
  }, [selectedEntity, selectedAccount, asOfDate]);

  useEffect(() => {
    if (selectedEntity) {
      loadPendingDraws(selectedEntity);
    }
  }, [selectedEntity]);

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
   * Load accounts for entity
   */
  const loadAccounts = async (entityId) => {
    try {
      const response = await api.get(`/api/entities/${entityId}/accounts`);
      // Filter for bank accounts
      const bankAccounts = response.data.filter(a =>
        a.account_type === 'ASSET' && a.account_number.startsWith('1')
      );
      setAccounts(bankAccounts);
      if (bankAccounts.length > 0) {
        setSelectedAccount(bankAccounts[0].id);
      }
    } catch (err) {
      console.error('Failed to load accounts:', err);
    }
  };

  /**
   * Load GL and bank transactions for reconciliation
   */
  const loadReconData = async () => {
    setLoading(true);
    setError(null);

    try {
      // Get unreconciled transactions
      const response = await api.get('/api/reconciliation/bank/unreconciled', {
        params: {
          entityId: selectedEntity,
          accountId: selectedAccount,
          asOfDate
        }
      });

      setGlEntries(response.data.glEntries || []);
      setBankTransactions(response.data.bankTransactions || []);
      setMatches(new Map());

      // Load summary
      loadSummary();
    } catch (err) {
      setError('Failed to load reconciliation data');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const loadPendingDraws = async (entityId) => {
    try {
      const response = await api.get('/api/holdback-draws/pending', {
        params: { entityId }
      });
      setPendingDraws(response.data.disbursements || []);
    } catch (err) {
      console.error('Failed to load pending holdback draws:', err);
      setPendingDraws([]);
    }
  };

  const handleVerifyDrawFromBank = async (drawId, importTransactionId) => {
    setVerifyingDraw(drawId);
    setError(null);
    try {
      const response = await api.post('/api/holdback-draws/verify-match', {
        drawId,
        importTransactionId,
      });
      setSuccess(response.data.message || 'Draw verified');
      loadPendingDraws(selectedEntity);
      loadReconData();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to verify draw');
    } finally {
      setVerifyingDraw(null);
    }
  };

  /**
   * Load reconciliation summary
   */
  const loadSummary = async () => {
    try {
      const response = await api.get('/api/reconciliation/bank/summary', {
        params: {
          entityId: selectedEntity,
          accountId: selectedAccount,
          asOfDate
        }
      });
      setSummary(response.data);
    } catch (err) {
      console.error('Failed to load summary:', err);
    }
  };

  /**
   * Auto-match transactions
   */
  const handleAutoMatch = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await api.post('/api/reconciliation/bank/auto-match', {
        entityId: selectedEntity,
        accountId: selectedAccount,
        asOfDate
      });

      // Reload data to show matches
      loadReconData();

      setSuccess(`Auto-matched ${response.data.summary.matched} transactions`);
    } catch (err) {
      setError('Auto-match failed');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Clear matched transactions as reconciled
   */
  const handleClearMatches = async () => {
    const matchIds = Array.from(matches.keys());

    if (matchIds.length === 0) {
      setError('No matches to clear');
      return;
    }

    setClearing(true);
    setError(null);

    try {
      const response = await api.post('/api/reconciliation/bank/clear', {
        matchIds,
        reconciliationDate: asOfDate
      });

      setSuccess(`Cleared ${response.data.clearedCount} transactions`);
      setMatches(new Map());
      loadReconData();
    } catch (err) {
      setError('Failed to clear transactions');
      console.error(err);
    } finally {
      setClearing(false);
    }
  };

  /**
   * Format currency
   */
  const formatCurrency = (value) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD'
    }).format(Math.abs(value));
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
    <div className="bank-recon-container">
      <div className="recon-header">
        <h1>Bank Reconciliation</h1>
        <p>Match General Ledger entries to actual bank transactions</p>
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

      {/* Controls */}
      <div className="recon-controls">
        <div className="control-group">
          <label>Entity</label>
          <select
            value={selectedEntity}
            onChange={(e) => setSelectedEntity(e.target.value)}
            disabled={loading}
          >
            {entities.map(e => (
              <option key={e.id} value={e.id}>
                {e.name} ({e.code})
              </option>
            ))}
          </select>
        </div>

        <div className="control-group">
          <label>Account</label>
          <select
            value={selectedAccount}
            onChange={(e) => setSelectedAccount(e.target.value)}
            disabled={loading || accounts.length === 0}
          >
            <option value="">Select account...</option>
            {accounts.map(a => (
              <option key={a.id} value={a.id}>
                {a.account_number} - {a.account_name}
              </option>
            ))}
          </select>
        </div>

        <div className="control-group">
          <label>As of Date</label>
          <input
            type="date"
            value={asOfDate}
            onChange={(e) => setAsOfDate(e.target.value)}
            disabled={loading}
          />
        </div>

        <div className="control-group">
          <button
            className="btn-action"
            onClick={handleAutoMatch}
            disabled={loading || !selectedAccount}
          >
            {loading ? 'Loading...' : 'Auto-Match'}
          </button>
        </div>

        <div className="control-group">
          <button
            className="btn-action btn-primary"
            onClick={handleClearMatches}
            disabled={clearing || matches.size === 0}
          >
            {clearing ? 'Clearing...' : `Clear (${matches.size})`}
          </button>
        </div>
      </div>

      {/* Summary */}
      {summary && (
        <div className={`recon-summary ${summary.status.toLowerCase()}`}>
          <div className="summary-box">
            <label>Bank Balance</label>
            <value>{formatCurrency(summary.bankBalance)}</value>
          </div>

          <div className="summary-box">
            <label>GL Balance</label>
            <value>{formatCurrency(summary.glBalance)}</value>
          </div>

          <div className="summary-box">
            <label>Variance</label>
            <value className={Math.abs(summary.variance) < 0.01 ? 'match' : 'mismatch'}>
              {formatCurrency(summary.variance)}
            </value>
          </div>

          <div className="summary-box">
            <label>Status</label>
            <value className={summary.status.toLowerCase()}>
              {summary.status}
            </value>
          </div>

          <div className="summary-box">
            <label>Transactions</label>
            <value>{summary.transactions.cleared} / {summary.transactions.total} cleared</value>
          </div>
        </div>
      )}

      {pendingDraws.length > 0 && (
        <div className="holdback-pending-panel">
          <h3>Pending Holdback Wire Disbursements</h3>
          <p className="help-text">
            These draws were exported from Loan Servicing. Match the net wire on your bank statement
            (memo contains HOLDBACK-DRAW:drawId) to verify payment.
          </p>
          <div className="holdback-pending-list">
            {pendingDraws.map((draw) => {
              const gross = Math.abs(Number(draw.gross_amount) || 0);
              const inspection = Math.abs(Number(draw.inspection_fee) || 0);
              const wire = Math.abs(Number(draw.wire_fee) || 0);
              const net = Math.abs(Number(draw.net_disbursement) || 0);
              const candidates = bankTransactions.filter((txn) => {
                const amt = Math.abs(Number(txn.amount) || 0);
                const text = `${txn.description || ''} ${draw.memo || ''}`;
                return Math.abs(amt - net) < 0.02 && text.includes(draw.draw_id);
              });
              const fallback = candidates.length
                ? candidates
                : bankTransactions.filter((txn) => Math.abs(Math.abs(Number(txn.amount) || 0) - net) < 0.02);

              return (
                <div key={draw.id} className="holdback-pending-row">
                  <div className="holdback-pending-info">
                    <strong>{draw.borrower_name || draw.loan_num || draw.draw_id}</strong>
                    <span>
                      {formatDate(draw.draw_date)} · Gross {formatCurrency(gross)}
                      {inspection > 0 ? ` · Inspection −${formatCurrency(inspection)}` : ''}
                      {wire > 0 ? ` · Wire −${formatCurrency(wire)}` : ''}
                      · Net wire {formatCurrency(net)}
                    </span>
                    <span className="holdback-memo">{draw.memo || `HOLDBACK-DRAW:${draw.draw_id}`}</span>
                    {inspection > 0 && (
                      <span className="help-text" style={{ display: 'block', marginTop: 4 }}>
                        Inspection ({formatCurrency(inspection)}) posts to account 5100 Draw &amp; Inspection Fees — not on this cash list.
                      </span>
                    )}
                  </div>
                  <div className="holdback-pending-actions">
                    {fallback.length > 0 ? (
                      <select
                        id={`match-${draw.draw_id}`}
                        defaultValue={fallback[0]?.id || ''}
                        disabled={verifyingDraw === draw.draw_id}
                      >
                        {fallback.map((txn) => (
                          <option key={txn.id} value={txn.id}>
                            {formatDate(txn.date)} — {txn.description?.slice(0, 40) || 'Bank line'} ({formatCurrency(Math.abs(txn.amount))})
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-muted">No matching bank line loaded</span>
                    )}
                    <button
                      className="btn-action btn-primary"
                      disabled={!fallback.length || verifyingDraw === draw.draw_id}
                      onClick={() => {
                        const sel = document.getElementById(`match-${draw.draw_id}`);
                        if (sel?.value) handleVerifyDrawFromBank(draw.draw_id, sel.value);
                      }}
                    >
                      {verifyingDraw === draw.draw_id ? 'Verifying…' : 'Verify wire'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Main Reconciliation View */}
      <div className="recon-main">
        {/* GL Column */}
        <div className="recon-column">
          <h2>General Ledger</h2>
          <div className="column-count">
            {glEntries.length} entries
          </div>

          <div className="transactions-list">
            {glEntries.length === 0 ? (
              <div className="empty-state">
                No unreconciled GL entries
              </div>
            ) : (
              glEntries.map(entry => {
                const amount = entry.debit > 0 ? entry.debit : -entry.credit;
                const matched = matches.has(entry.id);

                return (
                  <div
                    key={entry.id}
                    className={`transaction-row ${matched ? 'matched' : ''}`}
                    onClick={() => {
                      if (matched) {
                        matches.delete(entry.id);
                        setMatches(new Map(matches));
                      }
                    }}
                  >
                    <div className="txn-date">
                      {formatDate(entry.posting_date)}
                    </div>
                    <div className="txn-desc">
                      {entry.description}
                    </div>
                    <div className={`txn-amount ${amount >= 0 ? 'credit' : 'debit'}`}>
                      {amount >= 0 ? '+' : '-'}{formatCurrency(Math.abs(amount))}
                    </div>
                    {matched && <div className="match-badge">✓</div>}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Bank Column */}
        <div className="recon-column">
          <h2>Bank Transactions</h2>
          <div className="column-count">
            {bankTransactions.length} transactions
          </div>

          <div className="transactions-list">
            {bankTransactions.length === 0 ? (
              <div className="empty-state">
                No unmatched bank transactions
              </div>
            ) : (
              bankTransactions.map(txn => {
                const matched = matches.has(txn.id);

                return (
                  <div
                    key={txn.id}
                    className={`transaction-row ${matched ? 'matched' : ''}`}
                    onClick={() => {
                      if (matched) {
                        matches.delete(txn.id);
                        setMatches(new Map(matches));
                      }
                    }}
                  >
                    <div className="txn-date">
                      {formatDate(txn.date)}
                    </div>
                    <div className="txn-desc">
                      {txn.description}
                    </div>
                    <div className={`txn-amount ${txn.amount >= 0 ? 'credit' : 'debit'}`}>
                      {txn.amount >= 0 ? '+' : '-'}{formatCurrency(Math.abs(txn.amount))}
                    </div>
                    {matched && <div className="match-badge">✓</div>}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* Unmatched Items Summary */}
      {glEntries.length > 0 || bankTransactions.length > 0 ? (
        <div className="unmatched-summary">
          <h3>Unmatched Items</h3>
          <div className="unmatched-stats">
            <div className="stat">
              <span className="stat-label">GL</span>
              <span className="stat-value">{glEntries.length}</span>
            </div>
            <div className="stat">
              <span className="stat-label">Bank</span>
              <span className="stat-value">{bankTransactions.length}</span>
            </div>
            <div className="stat">
              <span className="stat-label">Total</span>
              <span className="stat-value">{glEntries.length + bankTransactions.length}</span>
            </div>
          </div>
          <p className="help-text">
            Use Auto-Match to automatically match transactions by amount and date.
            Items that don't match within 2 days or differ in amount require manual review.
          </p>
        </div>
      ) : (
        <div className="recon-complete">
          <div className="success-icon">✓</div>
          <h3>Reconciliation Complete</h3>
          <p>All transactions have been matched and cleared.</p>
        </div>
      )}
    </div>
  );
};

export default BankReconciliation;
