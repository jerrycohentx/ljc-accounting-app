/**
 * QBO trial balance → app COA rollup rules per entity.
 * Patterns are tested against full QBO account name (case-insensitive).
 */

export const ENTITY_TB_FILES = {
  'ent-ljc': '2025_LJC_FINANCIAL__LLC_Trial_Balance_8c9b.csv',
  'ent-justin': '2025_JUSTIN_FINANCIAL_LLC_Trial_Balance_6cff.csv',
  'ent-omc': '2025_OMC_Housing_LLC_Trial_Balance_aef4.csv',
  'ent-gm': '2025_Graceful_Meadows_Assisted_Living_LLC_Trial_Balance_d183.csv',
  'ent-qof': '2025_LJC_QOF_LLC_Trial_Balance_f6bb.csv',
  'ent-4jl': '2025_4_J___L_PARTNERS__LTD_Trial_Balance_1358.csv',
};

const CATEGORY_FALLBACK = {
  ASSET: '1999',
  LIABILITY: '2999',
  EQUITY: '3000',
  REVENUE: '4000',
  EXPENSE: '5000',
};

export const ENTITY_ROLLUP_CONFIG = {
  'ent-ljc': {
    fallbacks: [
      { category: 'ASSET', accountNumber: '1999' },
      { category: 'LIABILITY', accountNumber: '2999' },
      { category: 'EQUITY', accountNumber: '3000' },
      { category: 'REVENUE', accountNumber: '4000' },
      { category: 'EXPENSE', accountNumber: '5000' },
    ],
    mappings: [
      { pattern: /^simmons bank ckg-0260/i, accountNumber: '1000' },
      { pattern: /lone star ckg-7367|lone star bank checking|lone star money market/i, accountNumber: '1001' },
      { pattern: /^csb-checking|^b1 bank ckg|^fidelity$|marketable securities|retirement accounts|subsidiaries:/i, accountNumber: '1010' },
      { pattern: /^undeposited funds/i, accountNumber: '1100' },
      { pattern: /^accounts receivable|^centerpoint-/i, accountNumber: '1200' },
      { pattern: /notes receivable.*simmons dloc|notes receivable-lending:notes receivable-simmons dloc/i, accountNumber: '1310' },
      { pattern: /notes receivable|notes receivable:/i, accountNumber: '1300' },
      { pattern: /hold backs.*simmons|holdbacks.*simmons/i, accountNumber: '1350' },
      { pattern: /hold backs|holdbacks|lending customer trust|refinance fees/i, accountNumber: '1350' },
      { pattern: /rental property escrows|mortgage servicing|1410/i, accountNumber: '1410' },
      { pattern: /^reo property|^reo property:/i, accountNumber: '1500' },
      { pattern: /due from.*graceful meadows|due from - to:graceful meadows/i, accountNumber: '1900' },
      { pattern: /due from.*justin financial|due from - to:justin financial/i, accountNumber: '1901' },
      { pattern: /due from.*omc housing|due from - to:omc housing/i, accountNumber: '1902' },
      { pattern: /due from - to:ljc qof/i, accountNumber: '1903' },
      { pattern: /accrued interest payable - 4j&l/i, accountNumber: '2999' },
      { pattern: /^due from - to:|^due \(to\) from:/i, accountNumber: '1999' },
      { pattern: /^accounts payable$/i, accountNumber: '2000' },
      { pattern: /credit cards:amex|credit cards:amexl|^credit cards:amex/i, accountNumber: '2010' },
      { pattern: /credit cards(?!.*amex)/i, accountNumber: '2011' },
      { pattern: /dloc.*simmons|lines of credit:dloc|notes payable.*simmons|simmons bank reo/i, accountNumber: '2110' },
      { pattern: /notes payable.*4j&l partners|notes payable  - 4j&l partners/i, accountNumber: '2999' },
      { pattern: /notes payable|wloc|gloc|notes payable cre|ljc aviation|notes payable - jerry|profit sharing|deferred origination|deposits:/i, accountNumber: '2999' },
      { pattern: /retained earnings|owners equity|owners draw|additional contributions|members equity|partners equity/i, accountNumber: '3100' },
      { pattern: /rental income|^rental income:/i, accountNumber: '4100' },
      { pattern: /lending income|interest income|origination|funding fees|yield participation|dividend|gain \(loss\)|uncategorized income|unapplied cash payment income|finance charges|money market interest/i, accountNumber: '4000' },
      { pattern: /interest expense|lending:bank expenses:interest|rental property:interest expense|rental property:mortgage interest/i, accountNumber: '5000' },
      { pattern: /inspection|underwriting|draw|wire fee|release of lien|lender force paid property tax/i, accountNumber: '5100' },
      { pattern: /bank service charges|analysis charges|bank expenses:wire fees/i, accountNumber: '5200' },
      { pattern: /insurance expense|health insurance|rental property:insurance|member life insurance/i, accountNumber: '5300' },
      { pattern: /health insurance-partner|doctors|prescriptions|insurance premium/i, accountNumber: '5400' },
      { pattern: /utilities|rental property:utilities/i, accountNumber: '5500' },
      { pattern: /professional fees|legal and professional|legal fees|cokinos|harmon law|invicta|keever|rental property:legal/i, accountNumber: '5600' },
      { pattern: /computer and internet|office supplies|software subscription|loan management|quickbooks|web hosting|1password|carbonite|mortgage office/i, accountNumber: '5700' },
      { pattern: /chargeback|bounced checks|uncategorized expense/i, accountNumber: '5800' },
    ],
  },

  'ent-justin': {
    fallbacks: Object.entries(CATEGORY_FALLBACK).map(([category, accountNumber]) => ({ category, accountNumber })),
    mappings: [
      { pattern: /simmons- 5865|cash:ckg at simmons/i, accountNumber: '1000' },
      { pattern: /due \(to\) from:ljc financial/i, accountNumber: '1900' },
      { pattern: /due \(to\) from:4j&l/i, accountNumber: '2910' },
      { pattern: /real estate owned|franchise fees|inventory/i, accountNumber: '1500' },
      { pattern: /^accounts payable|payable to jerry cohen/i, accountNumber: '2000' },
      { pattern: /notes payable:ljc financial/i, accountNumber: '2900' },
      { pattern: /rehab holdback/i, accountNumber: '1350' },
      { pattern: /retained earnings|opening bal equity|owner'?s capital|partners equity|distributions/i, accountNumber: '3100' },
      { pattern: /bank service|miscellaneous|professional fees|taxes:property/i, accountNumber: '5000' },
    ],
  },

  'ent-omc': {
    fallbacks: Object.entries(CATEGORY_FALLBACK).map(([category, accountNumber]) => ({ category, accountNumber })),
    mappings: [
      { pattern: /simmons bank|checking at b1bank/i, accountNumber: '1000' },
      { pattern: /^accounts receivable/i, accountNumber: '1200' },
      { pattern: /due from \(to\):ljc financial/i, accountNumber: '1900' },
      { pattern: /notes receivable/i, accountNumber: '1300' },
      { pattern: /deposits and holdbacks|holdback|rehab holdback/i, accountNumber: '1350' },
      { pattern: /real estate owned/i, accountNumber: '1500' },
      { pattern: /chase card/i, accountNumber: '2011' },
      { pattern: /notes payable|real estate notes payable|wells fargo/i, accountNumber: '2110' },
      { pattern: /members equity|opening balance equity|contributions|draws/i, accountNumber: '3100' },
      { pattern: /rental property income|lending income|gain on sale|misc income/i, accountNumber: '4000' },
      { pattern: /automobile|bank service|computer|donations|dues|lending expenses|office supplies|rental property expenses|telephone|travel/i, accountNumber: '5000' },
    ],
  },

  'ent-gm': {
    fallbacks: [
      { category: 'ASSET', accountNumber: '1000' },
      { category: 'LIABILITY', accountNumber: '2100' },
      { category: 'EQUITY', accountNumber: '3100' },
      { category: 'REVENUE', accountNumber: '4000' },
      { category: 'EXPENSE', accountNumber: '5000' },
    ],
    mappings: [
      { pattern: /ckg account graceful|payments to deposit|quickbooks tax holding|uncategorized asset/i, accountNumber: '1000' },
      { pattern: /prepaid expenses/i, accountNumber: '1210' },
      { pattern: /^buildings/i, accountNumber: '1500' },
      { pattern: /furniture/i, accountNumber: '1510' },
      { pattern: /visa graceful/i, accountNumber: '2011' },
      { pattern: /payroll liabilities|direct deposit payable|federal taxes|federal unemployment|tx unemployment/i, accountNumber: '2100' },
      { pattern: /long-term loans from shareholders/i, accountNumber: '2200' },
      { pattern: /retained earnings/i, accountNumber: '3100' },
      { pattern: /services|late fee income|interest earned|uncategorized income|unapplied cash payment income/i, accountNumber: '4000' },
      { pattern: /^wages|payroll expenses|taxes:payroll taxes/i, accountNumber: '6000' },
      { pattern: /advertising|bank fees|dues|interest expense|legal|management fee|office expenses|outside services|referral|repairs|food service|supplies|taxes:|utilities/i, accountNumber: '5000' },
    ],
  },

  'ent-qof': {
    fallbacks: Object.entries(CATEGORY_FALLBACK).map(([category, accountNumber]) => ({ category, accountNumber })),
    mappings: [
      { pattern: /hadley street|purchase/i, accountNumber: '1500' },
      { pattern: /ljc financial/i, accountNumber: '2900' },
    ],
  },

  'ent-4jl': {
    fallbacks: Object.entries(CATEGORY_FALLBACK).map(([category, accountNumber]) => ({ category, accountNumber })),
    mappings: [
      { pattern: /simmons bank mm|cash:pnc|cash:savings|undeposited funds|^accounts receivable/i, accountNumber: '1000' },
      { pattern: /4302 westheimer escrows|accrued interest receivable/i, accountNumber: '1410' },
      { pattern: /due \(to\) from:ljc financial/i, accountNumber: '1900' },
      { pattern: /due \(to\) from:/i, accountNumber: '1999' },
      { pattern: /building-4302|land-4302|leasehold|loan fee|organization costs|furniture and equipment|software|parking carousel|prepaid commissions/i, accountNumber: '1500' },
      { pattern: /notes payable|accounts payable/i, accountNumber: '2000' },
      { pattern: /retained earnings|opening bal equity|partner 1 draws|shareholder draw/i, accountNumber: '3100' },
      { pattern: /rental income|money market interest/i, accountNumber: '4000' },
      { pattern: /bank service|insurance expense|ask my accountant/i, accountNumber: '5000' },
    ],
  },
};
