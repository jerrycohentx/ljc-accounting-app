/** KPI pack definitions (spec §4b). */

export const KPI_PACKS = {
  lending: {
    key: 'lending',
    label: 'Private / Hard-Money Lending',
    naics: '522292',
    kpis: [
      { key: 'net_interest_margin', label: 'Net Interest Margin', format: 'percent', polarity: 'higher_is_better', inputs: ['interest_income', 'interest_expense', 'avg_earning_assets'] },
      { key: 'yield_on_loans', label: 'Yield on Loans', format: 'percent', polarity: 'higher_is_better', inputs: ['interest_income', 'avg_loan_balance'] },
      { key: 'cost_of_funds', label: 'Cost of Funds', format: 'percent', polarity: 'lower_is_better', inputs: ['interest_expense', 'avg_borrowings'] },
      { key: 'spread', label: 'Spread', format: 'pp', polarity: 'higher_is_better', inputs: ['yield_on_loans', 'cost_of_funds'] },
      { key: 'delinquency_rate', label: 'Delinquency Rate', format: 'percent', polarity: 'lower_is_better', inputs: ['past_due_principal', 'total_principal'] },
      { key: 'default_ratio', label: 'Non-performing / Default Ratio', format: 'percent', polarity: 'lower_is_better', inputs: ['npl_principal', 'total_principal'] },
      { key: 'roa', label: 'Return on Assets', format: 'percent', polarity: 'higher_is_better', inputs: ['net_income', 'avg_total_assets'] },
      { key: 'roe', label: 'Return on Equity', format: 'percent', polarity: 'higher_is_better', inputs: ['net_income', 'avg_equity'] },
      { key: 'debt_to_equity', label: 'Debt-to-Equity', format: 'ratio', polarity: 'neutral', inputs: ['total_liabilities', 'total_equity'] },
      { key: 'efficiency_ratio', label: 'Efficiency Ratio', format: 'percent', polarity: 'lower_is_better', inputs: ['operating_expense', 'net_interest_income'] },
    ],
  },
  rental: {
    key: 'rental',
    label: 'Rental Real Estate',
    naics: '531110',
    kpis: [
      { key: 'noi', label: 'Net Operating Income (NOI)', format: 'currency', polarity: 'higher_is_better', inputs: ['rental_revenue', 'operating_expense'] },
      { key: 'cap_rate', label: 'Cap Rate', format: 'percent', polarity: 'higher_is_better', inputs: ['noi', 'property_value'] },
      { key: 'cash_on_cash', label: 'Cash-on-Cash Return', format: 'percent', polarity: 'higher_is_better', inputs: ['cash_flow', 'cash_invested'] },
      { key: 'dscr', label: 'Debt Service Coverage (DSCR)', format: 'ratio', polarity: 'higher_is_better', inputs: ['noi', 'debt_service'] },
      { key: 'occupancy_rate', label: 'Occupancy Rate', format: 'percent', polarity: 'higher_is_better', inputs: ['occupied_units', 'available_units'] },
      { key: 'vacancy_loss', label: 'Economic Vacancy', format: 'percent', polarity: 'lower_is_better', inputs: ['gpr', 'effective_rent'] },
      { key: 'operating_expense_ratio', label: 'Operating Expense Ratio', format: 'percent', polarity: 'lower_is_better', inputs: ['operating_expense', 'egi'] },
      { key: 'grm', label: 'Gross Rent Multiplier', format: 'ratio', polarity: 'neutral', inputs: ['property_value', 'gross_rent'] },
      { key: 'rent_psf', label: 'Rent per Square Foot', format: 'currency', polarity: 'higher_is_better', inputs: ['monthly_rent', 'rentable_sqft'] },
      { key: 'tenant_turnover', label: 'Tenant Turnover Rate', format: 'percent', polarity: 'lower_is_better', inputs: ['move_outs', 'total_units'] },
    ],
  },
  assisted_living: {
    key: 'assisted_living',
    label: 'Assisted Living / Senior Care',
    naics: '623312',
    kpis: [
      { key: 'census_rate', label: 'Occupancy (Census) Rate', format: 'percent', polarity: 'higher_is_better', inputs: ['occupied_days', 'available_days'] },
      { key: 'revpor', label: 'RevPOR', format: 'currency', polarity: 'higher_is_better', inputs: ['resident_revenue', 'occupied_units'] },
      { key: 'revpar', label: 'RevPAR', format: 'currency', polarity: 'higher_is_better', inputs: ['resident_revenue', 'available_units'] },
      { key: 'rev_per_resident_day', label: 'Avg Revenue per Resident Day', format: 'currency', polarity: 'higher_is_better', inputs: ['resident_revenue', 'occupied_days'] },
      { key: 'labor_cost_ratio', label: 'Labor Cost Ratio', format: 'percent', polarity: 'lower_is_better', inputs: ['labor_expense', 'total_revenue'] },
      { key: 'cost_per_resident_day', label: 'Cost per Resident Day', format: 'currency', polarity: 'lower_is_better', inputs: ['operating_expense', 'occupied_days'] },
      { key: 'operating_margin', label: 'Operating Margin', format: 'percent', polarity: 'higher_is_better', inputs: ['operating_income', 'total_revenue'] },
      { key: 'moveout_rate', label: 'Move-out / Turnover Rate', format: 'percent', polarity: 'lower_is_better', inputs: ['move_outs', 'avg_census'] },
    ],
  },
  generic: {
    key: 'generic',
    label: 'Generic Financial',
    naics: null,
    kpis: [
      { key: 'gross_margin', label: 'Gross Margin', format: 'percent', polarity: 'higher_is_better', inputs: ['revenue', 'cogs'] },
      { key: 'operating_margin', label: 'Operating Margin', format: 'percent', polarity: 'higher_is_better', inputs: ['operating_income', 'revenue'] },
      { key: 'net_margin', label: 'Net Margin', format: 'percent', polarity: 'higher_is_better', inputs: ['net_income', 'revenue'] },
      { key: 'current_ratio', label: 'Current Ratio', format: 'ratio', polarity: 'higher_is_better', inputs: ['current_assets', 'current_liabilities'] },
      { key: 'quick_ratio', label: 'Quick Ratio', format: 'ratio', polarity: 'higher_is_better', inputs: ['quick_assets', 'current_liabilities'] },
      { key: 'expense_ratio', label: 'Expense Ratio', format: 'percent', polarity: 'lower_is_better', inputs: ['expenses', 'revenue'] },
    ],
  },
};

/** Static QBO-style industry benchmark placeholders (v1 until live QBO fetch). */
export const INDUSTRY_BENCHMARKS = {
  '522292': {
    net_interest_margin: 6.0,
    delinquency_rate: 2.5,
    roa: 1.2,
    roe: 12.0,
    efficiency_ratio: 55.0,
  },
  '531110': {
    cap_rate: 5.5,
    occupancy_rate: 94.0,
    operating_expense_ratio: 38.0,
    dscr: 1.25,
  },
  '623312': {
    census_rate: 88.0,
    labor_cost_ratio: 52.0,
    operating_margin: 18.0,
    revpor: 4500,
  },
};

export function getKpiPack(packKey) {
  return KPI_PACKS[packKey] || KPI_PACKS.generic;
}

export function kpiPacksForEntity(entityId, segmentKey) {
  if (entityId === 'ent-ljc' && segmentKey === 'all') {
    return [KPI_PACKS.lending, KPI_PACKS.rental];
  }
  if (entityId === 'ent-ljc' && segmentKey === 'lending') return [KPI_PACKS.lending];
  if (entityId === 'ent-ljc' && segmentKey === 'rental') return [KPI_PACKS.rental];
  if (entityId === 'ent-gm') return [KPI_PACKS.assisted_living];
  return [KPI_PACKS.generic];
}
