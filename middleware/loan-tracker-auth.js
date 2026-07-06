export function loanTrackerKeyMiddleware(req, res, next) {
  const key = req.headers['x-loan-tracker-key'];
  const expected = process.env.LOAN_TRACKER_INTEGRATION_KEY;
  if (!expected || !key || key !== expected) {
    return res.status(401).json({ error: 'Invalid integration key' });
  }
  next();
}
