/**
 * Semantic guardrails for automatic bank categorization.
 *
 * Text rules are useful, but a broad or stale learned rule must never beat
 * obvious accounting meaning.  Keep this module pure so every import path can
 * use the same checks and so contradictions are easy to test.
 */

const clean = (value) => String(value || '').toUpperCase().replace(/\s+/g, ' ').trim();

export function inferCategorizationIntent(description, { amount = null } = {}) {
  const text = clean(description);
  const signedAmount = Number(amount);
  const isCredit = Number.isFinite(signedAmount) ? signedAmount > 0 : null;

  if (/\bC\.?\s*D\.?\s+INTEREST\b|\bCERTIFICATE OF DEPOSIT INTEREST\b/.test(text)) {
    return {
      code: 'BANK_INTEREST_INCOME',
      label: 'CD interest income',
      confidence: 1,
      expectedTypes: ['REVENUE'],
      preferredAccount: /INTEREST|BANK|C\.?D\.?/i,
      forbiddenAccount: /NSF|LATE FEE|OVERDRAFT|RENT|CHARGEBACK|FINANCE CHARGE/i,
      directionConflict: isCredit === false,
    };
  }

  if (/\bINTEREST (?:EARNED|CREDIT|PAID)\b|\bINTEREST PAYMENT\b/.test(text) && isCredit !== false) {
    return {
      code: 'BANK_INTEREST_INCOME',
      label: 'bank interest income',
      confidence: 0.98,
      expectedTypes: ['REVENUE'],
      preferredAccount: /INTEREST|BANK/i,
      forbiddenAccount: /NSF|LATE FEE|OVERDRAFT|RENT|CHARGEBACK/i,
      directionConflict: false,
    };
  }

  if (/\bNSF\b|NON[- ]SUFFICIENT FUNDS|RETURNED ITEM FEE/.test(text)) {
    return {
      code: isCredit === true ? 'NSF_FEE_INCOME' : 'BANK_FEE_EXPENSE',
      label: isCredit === true ? 'NSF fee income' : 'bank fee expense',
      confidence: 0.97,
      expectedTypes: isCredit === true ? ['REVENUE'] : ['EXPENSE'],
      preferredAccount: /NSF|RETURN(?:ED)? ITEM|BANK (?:SERVICE )?FEE/i,
      forbiddenAccount: /CD INTEREST|INTEREST INCOME|RENTAL INCOME/i,
      directionConflict: false,
    };
  }

  if (/ACCOUNT ANALYSIS CHARGE|SERVICE CHARGE|MAINTENANCE FEE|OVERDRAFT FEE/.test(text)) {
    return {
      code: 'BANK_FEE_EXPENSE',
      label: 'bank fee expense',
      confidence: 0.96,
      expectedTypes: ['EXPENSE'],
      preferredAccount: /BANK|SERVICE|ANALYSIS|OVERDRAFT|FEE/i,
      forbiddenAccount: /INTEREST INCOME|RENTAL INCOME/i,
      directionConflict: isCredit === true,
    };
  }

  return null;
}

export function validateCategorizationCandidate(description, account, context = {}) {
  const intent = inferCategorizationIntent(description, context);
  if (!intent || !account) return { ok: true, intent };

  const accountText = `${account.account_number || ''} ${account.account_name || ''}`.trim();
  const accountType = clean(account.account_type);
  const reasons = [];

  if (intent.directionConflict) {
    reasons.push(`transaction direction conflicts with ${intent.label}`);
  }
  if (intent.expectedTypes?.length && !intent.expectedTypes.includes(accountType)) {
    reasons.push(`${intent.label} requires ${intent.expectedTypes.join(' or ')}, not ${accountType || 'an unknown account type'}`);
  }
  if (intent.forbiddenAccount?.test(accountText)) {
    reasons.push(`${accountText || 'selected account'} conflicts with ${intent.label}`);
  }

  return {
    ok: reasons.length === 0,
    intent,
    reasons,
    message: reasons.length
      ? `Common-sense check blocked this categorization: ${reasons.join('; ')}.`
      : null,
  };
}

