/** Fictional demo data only. Never put real customers, phones or receipts here. */
import { referenceHash } from '../routes/receipts.js';
import type { Db } from './client.js';
import { branches, dishes, purchaseItems, purchases, restaurants } from './schema.js';

const catalog = [
  {
    name: 'Bulvar Bistro',
    cuisine: 'european',
    cashbackBps: 500,
    branches: ['Bulvar', 'Nizami küçəsi'],
    menu: [
      ['Mains', 'Creamy mushroom pasta', 1450],
      ['Mains', 'Grilled salmon', 2400],
      ['Desserts', 'Honey cake', 750],
      ['Drinks', 'Flat white', 550],
    ],
  },
  {
    name: 'Qala Kitchen',
    cuisine: 'azerbaijani',
    cashbackBps: 300,
    branches: ['İçərişəhər'],
    menu: [
      ['Mains', 'Lamb plov', 1800],
      ['Mains', 'Beef kebab', 1600],
      ['Salads', 'Shepherd salad', 650],
      ['Drinks', 'Black tea with thyme', 300],
    ],
  },
  {
    name: 'Xəzər Burger',
    cuisine: 'american',
    cashbackBps: 200,
    branches: ['28 May', 'Gənclik', 'Yasamal'],
    menu: [
      ['Burgers', 'Classic cheeseburger', 1150],
      ['Burgers', 'Smoky double burger', 1590],
      ['Sides', 'Sweet potato fries', 590],
    ],
  },
] as const;

/** Demo purchase references to type into the app's "enter code" screen. */
export const DEMO_REFERENCES = ['DEMO-0001', 'DEMO-0002', 'DEMO-0003', 'DEMO-EXPIRED'] as const;

export async function seed(db: Db, now = new Date()): Promise<void> {
  await db.transaction(async (tx) => {
    const created = [];
    for (const r of catalog) {
      const [restaurant] = await tx
        .insert(restaurants)
        .values({ name: r.name, cuisine: r.cuisine, cashbackBps: r.cashbackBps })
        .returning();
      const branchRows = await tx
        .insert(branches)
        .values(r.branches.map((name) => ({ restaurantId: restaurant!.id, name })))
        .returning();
      const dishRows = await tx
        .insert(dishes)
        .values(r.menu.map(([section, name, priceMinor]) => ({ restaurantId: restaurant!.id, section, name, priceMinor })))
        .returning();
      created.push({ branch: branchRows[0]!, dishes: dishRows });
    }

    const day = 86_400_000;
    for (const [index, reference] of DEMO_REFERENCES.entries()) {
      const { branch, dishes: menu } = created[index % created.length]!;
      const lines = menu.slice(0, 3).map((dish, i) => ({ dish, quantity: i === 0 ? 2 : 1 }));
      const expired = reference === 'DEMO-EXPIRED';
      const [purchase] = await tx
        .insert(purchases)
        .values({
          branchId: branch.id,
          referenceHash: referenceHash(reference),
          issuedAt: new Date(now.getTime() - (expired ? 40 : 1) * day),
          totalMinor: lines.reduce((sum, l) => sum + l.dish.priceMinor * l.quantity, 0),
          expiresAt: new Date(now.getTime() + (expired ? -10 : 30) * day),
        })
        .returning();
      await tx.insert(purchaseItems).values(
        lines.map((l) => ({
          purchaseId: purchase!.id,
          dishId: l.dish.id,
          name: l.dish.name,
          quantity: l.quantity,
          unitPriceMinor: l.dish.priceMinor,
        })),
      );
    }
  });
}
