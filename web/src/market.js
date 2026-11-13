/*
 * Pure market helpers: amounts, odds and payouts. No DOM, no network.
 * All NEAR amounts are handled as BigInt yoctoNEAR (1 NEAR = 10^24 yocto).
 */

const YOCTO_PER_NEAR = 10n ** 24n;

/**
 * Parse JSON returned by a contract view without losing precision.
 * The contract serialises u128 amounts as bare JSON numbers, which plain JSON.parse
 * rounds to the nearest double. With source-text access (modern browsers, Node 21+)
 * large integers are kept exactly as decimal strings.
 */
export function parseContractJson(text) {
  return JSON.parse(text, (key, value, context) => {
    if (typeof value === 'number' && !Number.isSafeInteger(value) && typeof context?.source === 'string' && /^\d+$/.test(context.source)) {
      return context.source;
    }
    return value;
  });
}

export function toBigInt(raw) {
  if (typeof raw === 'bigint') return raw;
  if (typeof raw === 'number') return Number.isFinite(raw) ? BigInt(Math.round(raw)) : 0n;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return BigInt(raw);
  return 0n;
}

/** "1.234 NEAR" with up to three decimals, trailing zeros removed. */
export function nearAmount(raw) {
  const value = toBigInt(raw);
  const whole = value / YOCTO_PER_NEAR;
  const fraction = (value % YOCTO_PER_NEAR).toString().padStart(24, '0').slice(0, 3).replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''} NEAR`;
}

/** Parse a user-entered NEAR amount into a yoctoNEAR string. Throws on invalid or zero input. */
export function toYocto(value) {
  const match = /^(\d+)(?:\.(\d{1,24}))?$/.exec(String(value).trim());
  if (!match) throw new Error('Enter a stake greater than zero, up to 24 decimal places.');
  const amount = BigInt(match[1]) * YOCTO_PER_NEAR + BigInt((match[2] || '').padEnd(24, '0') || '0');
  if (amount === 0n) throw new Error('Enter a stake greater than zero, up to 24 decimal places.');
  return amount.toString();
}

/**
 * Share of NEAR on each side in tenths of a percent, rounded to nearest so the two
 * sides always add up to exactly 100.0%. These are pool shares, not probabilities.
 */
export function odds(yesRaw, noRaw) {
  const yes = toBigInt(yesRaw);
  const no = toBigInt(noRaw);
  const total = yes + no;
  if (total === 0n) return { total, yesTenths: null, noTenths: null };
  const yesTenths = Number((yes * 2000n / total + 1n) / 2n);
  return { total, yesTenths, noTenths: 1000 - yesTenths };
}

export function formatTenths(tenths) {
  return tenths === null ? '-' : `${Math.floor(tenths / 10)}.${tenths % 10}%`;
}

/** Mirrors the contract's payout_for: pro rata winnings when Resolved, own stakes back when Void. */
export function payoutFor(fact, yesStake, noStake) {
  const yes = toBigInt(yesStake);
  const no = toBigInt(noStake);
  if (fact?.status === 'Void') return yes + no;
  if (fact?.status !== 'Resolved' || !fact.outcome) return 0n;
  const yesPool = toBigInt(fact.yes_pool);
  const noPool = toBigInt(fact.no_pool);
  const [stake, winning] = fact.outcome === 'Yes' ? [yes, yesPool] : [no, noPool];
  if (stake === 0n || winning === 0n) return 0n;
  return stake * (yesPool + noPool) / winning;
}

/** Short human label for a fact's status. */
export function statusLabel(fact) {
  switch (fact?.status) {
    case 'Resolved': return `Resolved ${fact.outcome === 'Yes' ? 'YES' : 'NO'}`;
    case 'Void': return 'Void · stakes refundable';
    case 'Pending': return 'Resolution being verified';
    default: return 'Open';
  }
}

/** True while staking and evidence submission are allowed. */
export function isAcceptingInput(fact, nowMs = Date.now()) {
  return fact?.status === 'Open' && Number(fact.resolve_after) > nowMs;
}

/** Whole cents (0 to 100) for one side's pool share; null while nobody has staked. */
export function cents(tenths) {
  return tenths === null ? null : Math.round(tenths / 10);
}

/**
 * What a new stake would pay if its side wins, using the contract's own payout_for on the pools
 * after the stake lands. Only the new stake's extra payout is returned, so an existing position
 * on the same side is not double counted. Assumes nobody else stakes before resolution.
 */
export function previewStake(fact, side, amountRaw, ownYes = 0n, ownNo = 0n) {
  const amount = toBigInt(amountRaw);
  const yes = toBigInt(fact.yes_pool);
  const no = toBigInt(fact.no_pool);
  const own = side === 'Yes' ? toBigInt(ownYes) : toBigInt(ownNo);
  const after = { status: 'Resolved', outcome: side, yes_pool: side === 'Yes' ? yes + amount : yes, no_pool: side === 'No' ? no + amount : no };
  const before = { status: 'Resolved', outcome: side, yes_pool: yes, no_pool: no };
  const stakes = (s) => (side === 'Yes' ? [s, 0n] : [0n, s]);
  const payout = payoutFor(after, ...stakes(own + amount)) - payoutFor(before, ...stakes(own));
  return { payout, profit: payout - amount, afterTenths: odds(after.yes_pool, after.no_pool).yesTenths };
}
