import { Navigate, useSearchParams } from 'react-router-dom';

/** Legacy URLs → single bank reconcile screen; preserve query params. */
export default function ReconcileRedirect() {
  const [sp] = useSearchParams();
  const next = new URLSearchParams(sp);
  if (!next.get('date') && next.get('asOf')) {
    next.set('date', next.get('asOf'));
    next.delete('asOf');
  }
  const q = next.toString();
  return <Navigate to={`/reconcile${q ? `?${q}` : ''}`} replace />;
}
