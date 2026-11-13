/** Cashback for one rated purchase line, in integer qəpik, rounded down.
 * shortcut: flat per-restaurant rate; replace when the owner approves reward rules. */
export function rewardMinor(unitPriceMinor: number, quantity: number, cashbackBps: number): number {
  if (![unitPriceMinor, quantity, cashbackBps].every(Number.isSafeInteger))
    throw new RangeError('Money inputs must be safe integers');
  if (unitPriceMinor < 0 || quantity <= 0 || cashbackBps < 0 || cashbackBps > 10_000)
    throw new RangeError('Money inputs out of range');
  // BigInt keeps price × quantity × bps exact before the division.
  const amount = (BigInt(unitPriceMinor) * BigInt(quantity) * BigInt(cashbackBps)) / 10_000n;
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Reward overflow');
  return Number(amount);
}
