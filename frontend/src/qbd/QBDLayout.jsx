import React, { useState, useRef, useEffect } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useEntity } from './EntityContext';
import QBDBackupDialog, { useBackupStatus, formatBackupShort } from './QBDBackupDialog';
import QBEmailIngestDialog, { useEmailIngestStatus, formatEmailScanShort } from './QBEmailIngestDialog';
import { backupAPI } from '../services/api';
import './qbd.css';

const MENUS = ['File', 'Edit', 'View', 'Lists', 'Favorites', 'Company', 'Customers', 'Vendors', 'Employees', 'Banking', 'Reports', 'Window', 'Help'];
const TOOLS = [
  ['🏠', 'Home', '/'],
  ['🏢', 'My Company', '/'],
  ['👥', 'Customers', null],
  ['🚚', 'Vendors', null],
  ['🧑‍💼', 'Employees', null],
  ['🏦', 'Bank Feeds', '/bank-feeds'],
  ['📊', 'Reports', '/reports'],
  ['🔑', 'User Licenses', null],
];

export default function QBDLayout() {
  const { entities, entityId, setEntityId } = useEntity();
  const nav = useNavigate();
  const loc = useLocation();
  const [openMenu, setOpenMenu] = useState(null);
  const [menuPos, setMenuPos] = useState({ left: 0, top: 0 });
  const [toast, setToast] = useState('');
  const [backupOpen, setBackupOpen] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const toastTimer = useRef(null);
  const { info: backupInfo, refresh: refreshBackup } = useBackupStatus();
  const { info: emailInfo, refresh: refreshEmail } = useEmailIngestStatus();

  const showToast = (m) => {
    setToast(m);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2200);
  };
  const goOrToast = (path, label) => (path ? nav(path) : showToast(`${label} — coming to the app`));
  const closeCompany = () => { localStorage.removeItem('token'); localStorage.removeItem('user'); window.location.href = '/login'; };

  const runBackupNow = () => {
    backupAPI.run()
      .then((r) => { showToast(r.data.message || 'Backup complete ✓'); refreshBackup(); })
      .catch((e) => showToast('Backup failed: ' + (e.response?.data?.error || e.message)));
  };

  const showAbout = () => {
    const app = backupInfo?.app;
    const backup = backupInfo?.backup;
    const lines = [
      app?.name || 'LJC AI Accounting',
      app?.buildLabel || `v${app?.version || '0.1.0'}`,
      '',
      `Last backup: ${formatBackupShort(backup?.lastBackupAt)}`,
      backup?.lastBackup?.filename ? `Latest file: ${backup.lastBackup.filename}` : null,
      `Auto backup: every ${backup?.intervalMinutes || 60} minutes`,
    ].filter(Boolean).join('\n');
    showToast(lines.replace(/\n/g, ' · '));
  };

  useEffect(() => {
    const close = (e) => {
      if (!e.target.closest('.qbd-menubar') && !e.target.closest('.qbd-topmenu')) setOpenMenu(null);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);

  const t = (s) => () => showToast(s);
  const useRegisterFor = () => nav('/accounts');
  const menuDefs = (n) => {
    switch (n) {
      case 'File':
        return [['H', 'Open Company'],
          ...entities.map((e) => [e.name, () => setEntityId(e.id)]),
          '-',
          ['Back Up Company…', runBackupNow],
          ['View Backups…', () => setBackupOpen(true)],
          ['Close Company', closeCompany], '-', ['Exit', closeCompany]];
      case 'Edit': return [['Find…', t('Find — live app')], ['Preferences…', t('Preferences — live app')]];
      case 'View': return [['Home Page', () => nav('/')], ['Open Window List', t('Live app')]];
      case 'Lists': return [['Chart of Accounts', () => nav('/accounts')], ['Item List', t('Item List — live app')], ['Class List', t('Live app')]];
      case 'Favorites': return [['Customize Favorites…', t('Live app')]];
      case 'Company': return [['Home Page', () => nav('/')], ['Chart of Accounts', () => nav('/accounts')], '-', ['Make General Journal Entries…', () => nav('/journal')], ['Set Closing Date…', () => nav('/period-close')], ['Company Information…', t('Live app')]];
      case 'Customers': return [['Customer Center', t('Live app')], '-', ['Create Invoices', t('Live app')], ['Receive Payments', t('Live app')], ['Create Sales Receipts', t('Live app')]];
      case 'Vendors': return [['Vendor Center', t('Live app')], '-', ['Enter Bills', t('Live app')], ['Pay Bills', t('Live app')]];
      case 'Employees': return [['Employee Center', t('Live app')], '-', ['Enter Time', t('Live app')]];
      case 'Banking': return [['Write Checks', () => nav('/write-checks')], ['Make Deposits', () => nav('/make-deposits')], ['Use Register…', useRegisterFor], ['Reconcile…', () => nav('/reconcile')], '-', ['Connect bank email…', () => setEmailOpen(true)], ['Bank Feeds', () => nav('/bank-feeds')]];
      case 'Reports': return [['Report Center', () => nav('/reports')], ['Tax Year Financials…', () => nav('/tax-financials')], '-', ['H', 'Company & Financial'], ['Balance Sheet', () => nav('/reports?r=bs')], ['Profit & Loss', () => nav('/reports?r=pl')], '-', ['H', 'Accountant & Lists'], ['Account Listing', () => nav('/accounts')], ['Journal', () => nav('/journal')]];
      case 'Window': return [['Home', () => nav('/')], ['Chart of Accounts', () => nav('/accounts')]];
      case 'Help': return [['About…', showAbout]];
      default: return [];
    }
  };

  const onMenuClick = (e, name) => {
    e.stopPropagation();
    if (openMenu === name) { setOpenMenu(null); return; }
    const r = e.target.getBoundingClientRect();
    setMenuPos({ left: r.left, top: r.bottom });
    setOpenMenu(name);
  };

  const toolActive = (path) => path && (path === '/' ? loc.pathname === '/' : loc.pathname.startsWith(path));

  return (
    <div className="qbd">
      <div className="qbd-titlebar">
        <span className="qbd-qb">qb</span>
        <select value={entityId} onChange={(e) => setEntityId(e.target.value)}>
          {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
        <span style={{ color: '#9fb6d2' }}>— Cohen Entities AI Accounting</span>
        <span className="sp" />
        <span className="qbd-wc">—  ▢  ✕</span>
      </div>

      <div className="qbd-menubar">
        {MENUS.map((m) => <span key={m} onClick={(e) => onMenuClick(e, m)}>{m}</span>)}
      </div>

      <div className="qbd-toolbar">
        {TOOLS.map(([ic, label, path]) => (
          <div key={label} className={'qbd-tbtn' + (toolActive(path) ? ' active' : '')} onClick={() => goOrToast(path, label)}>
            <span className="ti">{ic}</span>{label}
          </div>
        ))}
        <span className="sp" />
      </div>

      <div className="qbd-work"><Outlet context={{ showToast }} /></div>

      {openMenu && (
        <div className="qbd-topmenu" style={{ left: menuPos.left, top: menuPos.top }}>
          {menuDefs(openMenu).map((it, i) => {
            if (it === '-') return <div key={i} className="sep" />;
            if (it[0] === 'H') return <div key={i} className="hd">{it[1]}</div>;
            return <div key={i} onClick={() => { setOpenMenu(null); it[1] && it[1](); }}>{it[0]}</div>;
          })}
        </div>
      )}

      <QBDBackupDialog
        open={backupOpen}
        onClose={() => setBackupOpen(false)}
        showToast={showToast}
        onStatusChange={refreshBackup}
      />

      <QBEmailIngestDialog
        open={emailOpen}
        onClose={() => setEmailOpen(false)}
        showToast={showToast}
        onStatusChange={refreshEmail}
      />

      {toast && <div className="qbd-toast">{toast}</div>}
    </div>
  );
}
