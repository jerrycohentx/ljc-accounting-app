import React, { useEffect, useMemo, useState } from 'react';
import { leafLabel } from './helpers';
import { countVendorPatternMatches } from './vendorRuleHelpers';

/**
 * "Always apply to this vendor" — saves a durable bank rule and optionally
 * bulk-applies to matching items in the current review queue.
 */
export default function VendorAlwaysRuleModal({
  open,
  onClose,
  accounts = [],
  categoryAccountId,
  sourceDescription = '',
  initialPattern = '',
  previewItems = [],
  getPreviewText,
  reviewKind = 'charges',
  saving = false,
  onConfirm,
}) {
  const [pattern, setPattern] = useState(initialPattern);
  const [matchType, setMatchType] = useState('contains');

  useEffect(() => {
    if (open) {
      setPattern(initialPattern || '');
      setMatchType('contains');
    }
  }, [open, initialPattern]);

  const acct = accounts.find((a) => a.id === categoryAccountId);
  const catLabel = acct ? `${acct.number || acct.account_number} · ${leafLabel(acct.name || acct.account_name)}` : 'selected category';

  const matchCount = useMemo(
    () => countVendorPatternMatches(previewItems, getPreviewText, pattern, matchType),
    [previewItems, getPreviewText, pattern, matchType]
  );

  if (!open) return null;

  const how = matchType === 'exact'
    ? 'exactly matching'
    : matchType === 'starts_with'
      ? 'starting with'
      : 'containing';

  const itemWord = reviewKind === 'bank' ? 'transaction' : 'charge';

  return (
    <div className="qbd-modal-backdrop" onClick={() => !saving && onClose()}>
      <div className="qbd-window" style={{ width: 480, margin: '8vh auto' }} onClick={(e) => e.stopPropagation()}>
        <div className="qbd-wtitle">Always use this category for this vendor</div>
        <div className="qbd-wbody" style={{ padding: '12px 14px' }}>
          <p style={{ margin: '0 0 12px', fontSize: 13, color: '#333', lineHeight: 1.45 }}>
            {reviewKind === 'bank' ? 'Bank activity' : 'Charges'} {how}{' '}
            <strong>[{pattern || '…'}]</strong> will always book to <strong>{catLabel}</strong>.
            {' '}The app remembers this rule for every future import from this vendor.
          </p>
          <div style={{ marginBottom: 10 }}>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, marginBottom: 4 }}>
              Vendor match text (short — e.g. BLUEHOST.COM or GRACEFUL MEA)
            </label>
            <input
              className="qbd-inp"
              style={{ width: '100%' }}
              value={pattern}
              onChange={(e) => setPattern(e.target.value.toUpperCase())}
              autoFocus
            />
          </div>
          <div style={{ marginBottom: 10 }}>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, marginBottom: 4 }}>Match type</label>
            <select
              className="qbd-inp"
              style={{ width: '100%' }}
              value={matchType}
              onChange={(e) => setMatchType(e.target.value)}
            >
              <option value="contains">Contains (recommended)</option>
              <option value="starts_with">Starts with</option>
              <option value="exact">Exact match</option>
            </select>
          </div>
          <p style={{ margin: 0, fontSize: 12, color: matchCount ? '#1a5f3a' : '#666' }}>
            {pattern.trim().length < 3
              ? 'Enter at least 3 characters to preview matches.'
              : `${matchCount} ${itemWord}${matchCount === 1 ? '' : 's'} in this review list match.`}
          </p>
        </div>
        <div className="qbd-botbar">
          <button type="button" className="qbd-btn" disabled={saving} onClick={onClose}>Cancel</button>
          <span className="sp" />
          <button
            type="button"
            className="qbd-btn"
            disabled={saving || pattern.trim().length < 3}
            onClick={() => onConfirm({ pattern: pattern.trim(), matchType, postAll: false })}
          >
            Save rule only
          </button>
          <button
            type="button"
            className="qbd-btn-primary"
            disabled={saving || pattern.trim().length < 3}
            onClick={() => onConfirm({ pattern: pattern.trim(), matchType, postAll: true })}
          >
            {saving
              ? 'Saving…'
              : matchCount > 0
                ? `Save & apply to all (${matchCount})`
                : 'Save rule'}
          </button>
        </div>
      </div>
    </div>
  );
}
