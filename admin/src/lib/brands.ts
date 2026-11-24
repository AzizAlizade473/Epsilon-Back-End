import kfc from '../assets/brands/kfc.png';
import mcdonalds from '../assets/brands/mcdonalds.png';
import burgerKing from '../assets/brands/burger-king.png';
import pizzaHut from '../assets/brands/pizza-hut.png';
import dominos from '../assets/brands/dominos.png';

/**
 * Chain logos matched on the merchant name (port of the mobile app's matchBrand).
 * A brand is recognised only when the name IS the brand or STARTS with it followed
 * by a branch separator; look-alikes ("KFCX", "MY KFC KEBAB") get no logo.
 */
export type Brand = { id: string; name: string; aliases: readonly string[]; logo?: string };

export const brands: readonly Brand[] = [
  { id: 'kfc', name: 'KFC', aliases: ['KFC'], logo: kfc },
  { id: 'mcdonalds', name: "McDonald's", aliases: ["MCDONALD'S", 'MCDONALDS', "MC DONALD'S", 'MC DONALDS'], logo: mcdonalds },
  { id: 'burger-king', name: 'Burger King', aliases: ['BURGER KING'], logo: burgerKing },
  { id: 'pizza-hut', name: 'Pizza Hut', aliases: ['PIZZA HUT'], logo: pizzaHut },
  { id: 'papa-johns', name: "Papa John's", aliases: ["PAPA JOHN'S", 'PAPA JOHNS'] },
  { id: 'dominos', name: "Domino's", aliases: ["DOMINO'S", 'DOMINOS', "DOMINO'S PIZZA", 'DOMINOS PIZZA'], logo: dominos },
  { id: 'starbucks', name: 'Starbucks', aliases: ['STARBUCKS'] },
];

const normalise = (name: string) => name.toLocaleUpperCase('az').replace(/[’`´]/g, "'").replace(/\s+/g, ' ').trim();
const SEPARATOR = /^\s*[-–—,:/|]?\s*/;

export function matchBrand(name: string | null | undefined): { brand: Brand; branch: string | null } | null {
  if (!name) return null;
  const value = normalise(name);
  for (const brand of brands)
    // Longest alias first: "DOMINO'S PIZZA NİZAMİ" is branch "NİZAMİ", not "PIZZA NİZAMİ".
    for (const alias of [...brand.aliases].sort((x, y) => y.length - x.length)) {
      if (value === alias) return { brand, branch: null };
      if (!value.startsWith(alias)) continue;
      const rest = value.slice(alias.length);
      if (!/^[\s\-–—,:/|]/.test(rest)) continue;
      return { brand, branch: rest.replace(SEPARATOR, '').trim() || null };
    }
  return null;
}

/** Logo for a restaurant: the API's `logoBrand` id wins, else match on the name. */
export function logoFor(name: string | null | undefined, logoBrand?: string | null): string | undefined {
  const byId = logoBrand ? brands.find((b) => b.id === logoBrand) : undefined;
  return (byId ?? matchBrand(name)?.brand)?.logo;
}
