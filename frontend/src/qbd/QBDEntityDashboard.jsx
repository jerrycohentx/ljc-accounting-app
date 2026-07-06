import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { dashboardAPI, feedsAPI } from '../services/api';
import { fmt } from './helpers';

function formatWhen(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export default function QBDEntityDashboard() {
  const nav = useNavigate();
  const [data, setData] = useState(null);
  const [feeds, setFeeds] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      dashboardAPI.entitiesSummary(),
      feedsAPI.status(),
    ])
      .then(([dash, feed]) => {
        setData(dash.data);
        setFeeds(feed.data);
      })
      .catch(() => {
        setData(null);
        setFeeds(null);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const entities = data?.entities || [];
  const lastUpdated = data?.lastUpdated || feeds?.lastUpdated;

  return (
    <div>
      <div style={{ background: 'linear-gradient(#3f6cb0,#2a5596)', color: '#fff', fontWeight: 'bold', padding: '5px 12px', fontSize: 13, display: 'flex', alignItems: 'center', gap: 12 }}>
        <span>Multi-Entity Dashboard</span>
        <span className="qbd-muted" style={{ fontWeight: 'normal', fontSize: 11, color: '#d0e4ff' }}>
          {lastUpdated ? `Updated ${formatWhen(lastUpdated)}` : ''}
        </span>
        <span className="sp" style={{ flex: 1 }} />
        <button type="button" className="qbd-btn" style={{ fontSize: 11 }} onClick={load} disabled={loading}>
          Refresh
        </button>
      </div>

      {feeds && (
        <div className="qbd-dash-feeds">
          <span>Plaid sync: {formatWhen(feeds.plaid?.lastRunAt)}</span>
          <span>Email: {formatWhen(feeds.email?.lastRunAt)}</span>
          <span>Auto-load: {formatWhen(feeds.autoLoad?.lastRunAt)}</span>
          {(data?.totalPendingFeedCount || 0) > 0 && (
            <button type="button" className="qbd-dash-review-link" onClick={() => nav('/feed-review')}>
              {data.totalPendingFeedCount} awaiting review ▶
            </button>
          )}
        </div>
      )}

      {loading ? (
        <div className="qbd-empty">Loading entity summaries…</div>
      ) : (
        <div className="qbd-dash-grid">
          {entities.map((ent) => (
            <div key={ent.id} className="qbd-dash-card">
              <div className="qbd-dash-card-head">
                <strong>{ent.name}</strong>
                <span className="qbd-muted">{ent.code || ent.id}</span>
              </div>
              <div className="qbd-dash-metrics">
                <div className="qbd-dash-metric">
                  <span>Cash / Bank</span>
                  <b>{fmt(ent.cashBalance)}</b>
                </div>
                <div className="qbd-dash-metric">
                  <span>Receivables</span>
                  <b>{fmt(ent.arBalance)}</b>
                </div>
                <div className="qbd-dash-metric">
                  <span>Notes Payable</span>
                  <b>{fmt(ent.loanPayableBalance)}</b>
                </div>
                <div className="qbd-dash-metric">
                  <span>Unreconciled</span>
                  <b>{ent.unreconciledCount ?? 0}</b>
                </div>
                <div className="qbd-dash-metric">
                  <span>Pending review</span>
                  <b className={ent.pendingFeedCount > 0 ? 'qbd-warn-num' : ''}>{ent.pendingFeedCount ?? 0}</b>
                </div>
                <div className="qbd-dash-metric wide">
                  <span>Last feed sync</span>
                  <b>{formatWhen(ent.lastFeedSync)}</b>
                </div>
              </div>
              {ent.pendingFeedCount > 0 && (
                <button type="button" className="qbd-btn qbd-dash-action" onClick={() => nav('/feed-review')}>
                  Review {ent.pendingFeedCount} item{ent.pendingFeedCount === 1 ? '' : 's'}
                </button>
              )}
            </div>
          ))}
          {!entities.length && <div className="qbd-empty">No active entities found.</div>}
        </div>
      )}
    </div>
  );
}
