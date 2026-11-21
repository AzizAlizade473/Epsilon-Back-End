import type { FiscalDocument, FiscalItem } from '../src/fiscal/document.js';

/**
 * Test receipts. TAM STORE reproduces a real receipt's merchant and line data as
 * provided by the product owner; its Fiscal ID is synthetic. These are fixtures,
 * not proof of live e-kassa retrieval.
 */
const item = (lineNo: number, name: string, quantityMilli: number, unitPriceMinor: number, lineTotalMinor: number, unit: string | null = 'ədəd'): FiscalItem => ({
  lineNo,
  originalName: name,
  normalizedName: name,
  quantityMilli,
  unit,
  unitPriceMinor,
  lineTotalMinor,
  discountMinor: null,
  vatRatePercent: null,
  vatMinor: null,
});

const base = (fiscalId: string, over: Partial<FiscalDocument['merchant']>, items: FiscalItem[], extra: Partial<FiscalDocument['receipt']> = {}): FiscalDocument => ({
  merchant: {
    displayName: 'Merchant',
    legalName: null,
    voen: null,
    objectName: null,
    objectCode: null,
    address: null,
    city: null,
    ...over,
  },
  receipt: {
    fiscalId,
    number: null,
    documentId: null,
    type: 'sale',
    issuedAt: '2026-11-16T17:16:02+04:00',
    currency: 'AZN',
    totalMinor: items.reduce((s, i) => s + i.lineTotalMinor, 0),
    subtotalMinor: null,
    discountMinor: null,
    vatMinor: null,
    vatBreakdown: [],
    payment: { method: null, cashMinor: null, cashlessMinor: null, bonusMinor: null, changeMinor: null },
    ...extra,
  },
  items,
  device: { model: null, serialNumber: null, nmqRegistrationNumber: null },
  additionalFields: {},
});

export const TAM_STORE = base(
  'TESTFISC0001',
  {
    displayName: 'TAM STORE',
    legalName: 'TAM STORE MMC',
    voen: '1506475881',
    objectCode: '1506475881-20001',
    address: 'AZ1025, Bakı şəhəri, Xətai rayonu, Həsən Salmanı, ev 1, 1-ci mərtəbə, qapı 11',
    city: 'Bakı',
  },
  [item(1, 'COCA COLA ZERO 2LT PET', 1000, 230, 230), item(2, 'TS MARKET TORBASI ORTA 3 1X60 SM', 1000, 7, 7)],
  { number: '1421', vatMinor: 36, vatBreakdown: [{ ratePercent: 18, amountMinor: 36 }], payment: { method: 'cashless', cashMinor: 0, cashlessMinor: 237, bonusMinor: 0, changeMinor: 0 } },
);

export const NON_PARTNER_RESTAURANT = base(
  'TESTFISC0002',
  { displayName: 'NARGIZ RESTORAN', legalName: 'NARGIZ MMC', voen: '1111111111', objectCode: '1111111111-20001' },
  [item(1, 'TOYUQ PLOV', 1000, 850, 850), item(2, 'AYRAN 0.5L', 2000, 150, 300)],
);

export const CAFE = base('TESTFISC0003', { displayName: 'CAFE SUNRISE', voen: '2222222222' }, [item(1, 'LATTE', 1000, 450, 450)]);

/** Partner restaurant: matched by establishment code to the seeded branch in the tests. */
export const PARTNER_RESTAURANT = base(
  'TESTFISC0004',
  { displayName: 'DOLMA HOUSE', legalName: 'DOLMA HOUSE MMC', voen: '3333333333', objectCode: '3333333333-20001' },
  [item(1, 'YARPAQ DOLMASI', 1000, 1200, 1200), item(2, 'ŞORBA', 1000, 600, 600)],
);

export const UNKNOWN_BUSINESS = base('TESTFISC0005', { displayName: 'XYZ MMC', voen: '4444444444' }, [item(1, 'MƏHSUL 1', 1000, 100, 100)]);

export const PHARMACY = base('TESTFISC0006', { displayName: 'ZEYTUN APTEK', voen: '5555555555' }, [item(1, 'PARASETAMOL 500MG', 1000, 120, 120)]);

/** Weighed line and receipt-level printed discount. */
export const WEIGHED = base(
  'TESTFISC0007',
  { displayName: 'KAFE NUR', voen: '6666666666' },
  [item(1, 'AF LIMON KQ', 370, 219, 81, 'kq'), item(2, 'ÇAY', 1000, 100, 100)],
  { discountMinor: 10, totalMinor: 171 },
);

export const ALL = [TAM_STORE, NON_PARTNER_RESTAURANT, CAFE, PARTNER_RESTAURANT, UNKNOWN_BUSINESS, PHARMACY, WEIGHED];
export const qr = (fiscalId: string) => `https://monitoring.e-kassa.gov.az/#/index?doc=${fiscalId}`;
