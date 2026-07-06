/**
 * Category suggestion + learning for bank import / feed review.
 * Wraps bank_categorization_rules (DB) — learned rules use priority 5.
 */

import { categorizeTransaction } from './categorization-rules.js';
import { learnCategorizationRule } from './import-commit.js';
import { matchCreVendorHint } from './cre-categorization.js';

/**
 * Suggest offset GL account for a pending import line.
 * @returns {{ offsetAccountId, offsetAccountNumber, ruleId, label, confidence, categorySource, isTransfer, isChargeback }}
 */
export async function suggestCategoryForImport(db, entityId, description) {
  const cat = await categorizeTransaction(db, entityId, description);

  if (cat.isChargeback) {
    return {
      ...cat,
      confidence: 0.9,
      categorySource: 'rule',
    };
  }

  if (!cat.offsetAccountId) {
    return {
      offsetAccountId: null,
      offsetAccountNumber: null,
      ruleId: null,
      label: null,
      confidence: 0,
      categorySource: null,
      isTransfer: false,
      isChargeback: false,
    };
  }

  let confidence = 0.78;
  let categorySource = 'rule';

  if (cat.ruleId) {
    const rule = await db.get(
      'SELECT priority, label FROM bank_categorization_rules WHERE id = ?',
      [cat.ruleId]
    );
    if (rule) {
      const learned = rule.priority <= 5 || /^Learned:/i.test(rule.label || '');
      if (learned) {
        confidence = 0.95;
        categorySource = 'learned';
      } else if (rule.priority < 30) {
        confidence = 0.88;
      } else if (rule.priority < 80) {
        confidence = 0.82;
      }
    }
  }

  return {
    ...cat,
    confidence,
    categorySource,
    propertyHint: matchCreVendorHint(description),
  };
}

/** Persist a learned rule when user approves or manually categorizes. */
export async function learnFromUserCategory(db, { entityId, description, offsetAccountId }) {
  return learnCategorizationRule(db, { entityId, description, offsetAccountId });
}
