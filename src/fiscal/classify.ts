import { and, eq } from 'drizzle-orm';

import type { Db, Tx } from '../db/client.js';
import { branches, merchantClassifications, restaurants } from '../db/schema.js';
import type { FiscalDocument } from './document.js';

/** Broad sector → specific business types. */
export const TAXONOMY = {
  horeca: ['restaurant', 'cafe', 'coffee_shop', 'fast_food', 'bakery_cafe', 'other_food_service'],
  retail: ['supermarket', 'grocery_store', 'convenience_store', 'clothing_store', 'electronics_store', 'other_retail'],
  healthcare: ['pharmacy', 'clinic', 'other_healthcare'],
  automotive: ['gas_station', 'other_automotive'],
  services: ['other_services'],
  other: ['other'],
  unknown: ['unknown'],
} as const;
export type Sector = keyof typeof TAXONOMY;
export type BusinessType = (typeof TAXONOMY)[Sector][number];
export const sectorOf = (type: BusinessType): Sector =>
  (Object.keys(TAXONOMY) as Sector[]).find((s) => (TAXONOMY[s] as readonly string[]).includes(type))!;

export type ClassificationMethod = 'epsilon_partner' | 'cache' | 'name_rule' | 'ai_assisted' | 'none';
export type Classification = {
  sector: Sector;
  businessType: BusinessType;
  method: ClassificationMethod;
  /** verified: Epsilon's own partner record; rule: deterministic name evidence; ai: model suggestion; unverified: unknown. */
  status: 'verified' | 'rule' | 'ai' | 'unverified';
  evidence: string[];
  restaurantId: string | null;
  branchId: string | null;
  cashbackBps: number;
};

const UNKNOWN: Classification = {
  sector: 'unknown',
  businessType: 'unknown',
  method: 'none',
  status: 'unverified',
  evidence: [],
  restaurantId: null,
  branchId: null,
  cashbackBps: 0,
};

/** Upper-case ASCII fold for keyword matching (POS printers often drop Azerbaijani letters). */
export const foldUpper = (s: string) =>
  s
    .normalize('NFKC')
    .toLocaleUpperCase('az')
    .replace(/[ƏÖÜÇŞĞİI]/g, (c) => ({ Ə: 'E', Ö: 'O', Ü: 'U', Ç: 'C', Ş: 'S', Ğ: 'G', İ: 'I', I: 'I' })[c]!)
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();

/**
 * Merchant-identity rules: they read the business NAME only, never the products
 * (a supermarket sells coffee, a restaurant sells bottled water).
 */
const RULES: { type: BusinessType; pattern: RegExp; label: string }[] = [
  { type: 'pharmacy', pattern: /\b(APTEK|APTEKA|PHARMA|PHARMACY|ECZANE)\b/, label: 'pharmacy keyword' },
  { type: 'gas_station', pattern: /\b(AZPETROL|SOCAR PETROL|LUKOIL|YANACAQ DOLDURMA|DOLDURMA MENTEQESI|PETROL STATION)\b/, label: 'fuel station keyword' },
  { type: 'supermarket', pattern: /\b(SUPERMARKET|HIPERMARKET|HYPERMARKET|BRAVO|ARAZ MARKET|ARAZ SUPERMARKET|TAM STORE|TAMSTORE|BAZARSTORE|BAZAR STORE|OBA MARKET|RAHAT MARKET|NEPTUN|AL MARKET|SPAR|BOLLUQ)\b/, label: 'supermarket name' },
  { type: 'electronics_store', pattern: /\b(KONTAKT HOME|BAKU ELECTRONICS|IRSHAD ELECTRONICS|IRSAD ELECTRONICS)\b/, label: 'electronics chain' },
  { type: 'clothing_store', pattern: /\b(LC WAIKIKI|ZARA|DEFACTO|KOTON|MANGO|BERSHKA)\b/, label: 'clothing chain' },
  { type: 'fast_food', pattern: /\b(KFC|MCDONALD S|MCDONALDS|BURGER KING|HESBURGER|PAPA JOHN S|DOMINO S|POPEYES)\b/, label: 'fast-food chain' },
  { type: 'coffee_shop', pattern: /\b(COFFEE|KOFE|STARBUCKS|ESPRESSO BAR|COFFEESHOP)\b/, label: 'coffee keyword' },
  { type: 'cafe', pattern: /\b(KAFE|CAFE|KAFESI)\b/, label: 'cafe keyword' },
  { type: 'restaurant', pattern: /\b(RESTORAN|RESTAURANT|RESTORANI|SADLIQ SARAYI)\b/, label: 'restaurant keyword' },
  { type: 'grocery_store', pattern: /\b(ERZAQ|BAQQAL|MARKET)\b/, label: 'grocery keyword' },
];

/** Deterministic classification from the business names, or null when no or conflicting evidence. */
export function classifyByName(doc: FiscalDocument): { type: BusinessType; evidence: string[] } | null {
  const names = [doc.merchant.displayName, doc.merchant.objectName, doc.merchant.legalName].filter((n): n is string => !!n);
  const hits = new Map<BusinessType, string[]>();
  for (const name of names) {
    const folded = foldUpper(name);
    // First matching rule per name: specific chains/keywords are listed before generic ones.
    const rule = RULES.find((r) => r.pattern.test(folded));
    if (rule) hits.set(rule.type, [...(hits.get(rule.type) ?? []), `${rule.label}: "${name}"`]);
  }
  if (hits.size !== 1) return null; // nothing, or names disagree: don't guess
  const [type, evidence] = [...hits][0]!;
  return { type, evidence };
}

/** Optional AI step. Must return null (never throw) when disabled, over quota or unsure. */
export interface SectorAdvisor {
  suggest(doc: FiscalDocument): Promise<{ type: BusinessType; evidence: string[] } | null>;
}
export const noAdvisor: SectorAdvisor = { suggest: async () => null };

type Conn = Db | Tx;

export async function classifyMerchant(conn: Conn, doc: FiscalDocument, advisor: SectorAdvisor): Promise<Classification> {
  const { voen, objectCode } = doc.merchant;

  // 1. Epsilon's own partner records: establishment code (branch) first, then VÖEN (company).
  const partnerBy = async (where: ReturnType<typeof eq>) =>
    (
      await conn
        .select({ restaurant: restaurants, branchId: branches.id })
        .from(restaurants)
        .innerJoin(branches, eq(branches.restaurantId, restaurants.id))
        .where(where)
        .limit(1)
    )[0];
  const byBranch = objectCode ? await partnerBy(eq(branches.objectCode, objectCode)) : undefined;
  const partner = byBranch ?? (voen ? await partnerBy(eq(restaurants.voen, voen)) : undefined);
  if (partner)
    return {
      sector: 'horeca',
      businessType: 'restaurant',
      method: 'epsilon_partner',
      status: 'verified',
      evidence: [`Epsilon partner "${partner.restaurant.name}" matched by ${byBranch ? 'establishment code' : 'VÖEN'}`],
      restaurantId: partner.restaurant.id,
      // A VÖEN-only match does not say which branch: no branch attribution then.
      branchId: byBranch ? partner.branchId : null,
      cashbackBps: partner.restaurant.cashbackBps,
    };

  // 2. Cached decision for this establishment.
  if (voen) {
    const [cached] = await conn
      .select()
      .from(merchantClassifications)
      .where(and(eq(merchantClassifications.voen, voen), eq(merchantClassifications.objectCode, objectCode ?? '')));
    if (cached) {
      const type = cached.businessType as BusinessType;
      return {
        ...UNKNOWN,
        sector: sectorOf(type),
        businessType: type,
        method: 'cache',
        status: cached.method === 'ai_assisted' ? 'ai' : 'rule',
        evidence: cached.evidence as string[],
      };
    }
  }

  // 3. Deterministic name rules, then 4. the optional AI advisor.
  const byName = classifyByName(doc);
  const byAi = byName ? null : await advisor.suggest(doc);
  const found = byName ?? byAi;
  if (!found || found.type === 'unknown') return UNKNOWN;
  const method: ClassificationMethod = byName ? 'name_rule' : 'ai_assisted';
  if (voen)
    await conn
      .insert(merchantClassifications)
      .values({ voen, objectCode: objectCode ?? '', sector: sectorOf(found.type), businessType: found.type, method, evidence: found.evidence })
      .onConflictDoNothing();
  return {
    ...UNKNOWN,
    sector: sectorOf(found.type),
    businessType: found.type,
    method,
    status: byName ? 'rule' : 'ai',
    evidence: found.evidence,
  };
}
