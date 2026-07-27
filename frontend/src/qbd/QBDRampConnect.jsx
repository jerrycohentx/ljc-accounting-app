import React, { useEffect, useState, useCallback } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useEntity } from './EntityContext';
import { rampAPI } from '../services/api';

// Plain-English Ramp connection screen. Connect once, then Ramp card activity
// flows into "Check Categories" automatically — nothing posts until reviewed.
export default function QBDRampConnect() {
  const { entityId } = useEntity();
  const { showToast } = useOutletContext() || {};
  const toast = (m) => (showToast ? showToast(m) : null);

  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [environment, setEnvironment] = useState('production');
  const [businessName, setBusinessName] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(() => {
    if (!entityId) return;
    setLoading(true);
    rampAPI.status(entityId)
      .then((r) => setStatus(r.data))
      .catch(() => setStatus(null))
      .finally(() => setLoading(false));
  }, [entityId]);

  useEffect(() => { load(); }, [load]);

  const connect = async () => {
    if (!clientId.trim() || !clientSecret.trim()) {
      toast('Enter the Ramp Client ID and Client Secret.');
      return;
    }
    setConnecting(true);
    try {
      await rampAPI.connect(entityId, {
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        environment,
        businessName: businessName.trim() || null,
      });
      toast('Ramp connected. Pulling recent card activity…');
      setClientId('');
      setClientSecret('');
      const sres = await rampAPI.sync(entityId);
      const n = sres.data?.journalEntriesCreated || 0;
      toast(n
        ? `${n} Ramp transaction(s) pulled in — review them in Check Categories.`
        : 'Ramp connected. No new card activity yet.');
      load();
    } catch (err) {
      toast('Could not connect Ramp: ' + (err.response?.data?.error || err.message));
    } finally { setConnecting(false); }
  };

  const syncNow = async () => {
    setSyncing(true);
    try {
      const r = await rampAPI.sync(entityId);
      const n = r.data?.journalEntriesCreated || 0;
      toast(n
        ? `${n} new Ramp transaction(s) pulled in — review them in Check Categories.`
        : 'No new Ramp card activity since the last check.');
      load();
    } catch (err) {
      toast('Sync failed: ' + (err.response?.data?.error || err.message));
    } finally { setSyncing(false); }
  };

  const disconnect = async () => {
    setConnecting(true);
    try {
      await rampAPI.disconnect(entityId);
      toast('Ramp disconnected.');
      load();
    } catch (err) {
      toast('Disconnect failed: ' + (err.response?.data?.error || err.message));
    } finally { setConnecting(false); }
  };

  const connected = status?.connected;
  const conn = status?.connection;
  const auto = status?.autoSync;

  return (
    <div>
      <div style={{ background: 'linear-gradient(#3f6cb0,#2a5596)', color: '#fff', fontWeight: 'bold', padding: '5px 12px', fontSize: 13 }}>
        Ramp Card Connection
      </div>

      {loading ? (
        <div className="qbd-form"><div className="qbd-muted">Loading…</div></div>
      ) : connected ? (
        <div className="qbd-form">
          <div className="fhd">Connected</div>
          <div className="frow"><label>Business</label><span>{conn?.businessName || 'Ramp account'}</span></div>
          <div className="frow"><label>Environment</label><span>{conn?.environment || 'production'}</span></div>
          <div className="frow">
            <label>Last checked</label>
            <span>{conn?.lastSyncedAt ? new Date(conn.lastSyncedAt).toLocaleString() : 'not yet'}</span>
          </div>
          {auto?.enabled && (
            <div className="frow">
              <label>Automatic</label>
              <span className="qbd-muted">Ramp activity is checked every {auto.intervalHours}h automatically. New charges land in Check Categories.</span>
            </div>
          )}
          <div className="qbd-botbar">
            <span className="qbd-muted">Ramp charges book to account {auto?.cardAccountNumber || '2015'} (Ramp Card) and wait for your review — nothing posts on its own.</span>
            <span className="sp" />
            <button className="qbd-btn" disabled={connecting} onClick={disconnect}>Disconnect</button>
            <button className="qbd-btn" disabled={syncing} onClick={syncNow} style={{ fontWeight: 'bold', marginLeft: 8 }}>
              {syncing ? 'Checking…' : 'Check for new activity'}
            </button>
          </div>
        </div>
      ) : (
        <div className="qbd-form">
          <div className="fhd">Connect your Ramp account</div>
          <div className="frow">
            <label>Business name</label>
            <input type="text" value={businessName} onChange={(e) => setBusinessName(e.target.value)} placeholder="(optional label)" style={{ minWidth: 280 }} />
          </div>
          <div className="frow">
            <label>Client ID</label>
            <input type="text" value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" style={{ minWidth: 360 }} />
          </div>
          <div className="frow">
            <label>Client Secret</label>
            <input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="off" style={{ minWidth: 360 }} />
          </div>
          <div className="frow">
            <label>Environment</label>
            <select value={environment} onChange={(e) => setEnvironment(e.target.value)} style={{ width: 200 }}>
              <option value="production">Production (live)</option>
              <option value="demo">Demo (test)</option>
            </select>
          </div>
          <div className="qbd-botbar">
            <span className="qbd-muted">
              Create a Ramp API app (Ramp → Settings → Developer / API) with the <strong>transactions:read</strong> scope, then paste its Client ID and Secret here. Credentials are encrypted.
            </span>
            <span className="sp" />
            <button className="qbd-btn" disabled={connecting} onClick={connect} style={{ fontWeight: 'bold' }}>
              {connecting ? 'Connecting…' : 'Connect Ramp'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
