/** What a scripted buyer wants: its seats, and the most it pays for one, in the token's base units. */
export interface BuyerProfile {
  /** The first label of the buyer's account id: `buyer-01` is `buyer-01.<parent>`. */
  name: string;
  seats: number;
  /** The buyer commits to a pool only if its seat price is at most this. */
  topPrice: bigint;
}

function profile(n: number, seats: number, topPrice: bigint): BuyerProfile {
  return { name: `buyer-${String(n).padStart(2, '0')}`, seats, topPrice };
}

/**
 * The 20 scripted buyers. Six accept both scenarios' prices (100 seats), eight accept only the
 * `fills` price (100 more) and six accept neither. So `fills` sees 200 seats wanted for its 192, and
 * the last buyers to arrive get a reduced offer or none, while `fails` sees 100 and expires. No buyer
 * wants more than the pools' 24 seats per buyer, and none spends more than the default budget of
 * 10,000 base units at its top price.
 */
export const PROFILES: readonly BuyerProfile[] = [
  profile(1, 24, 400n),
  profile(2, 20, 400n),
  profile(3, 18, 400n),
  profile(4, 16, 400n),
  profile(5, 12, 400n),
  profile(6, 10, 400n),
  profile(7, 18, 250n),
  profile(8, 16, 250n),
  profile(9, 14, 250n),
  profile(10, 14, 250n),
  profile(11, 12, 250n),
  profile(12, 10, 250n),
  profile(13, 8, 250n),
  profile(14, 8, 250n),
  profile(15, 12, 150n),
  profile(16, 10, 150n),
  profile(17, 8, 150n),
  profile(18, 6, 150n),
  profile(19, 4, 150n),
  profile(20, 2, 150n),
];

/** The buyer's account: `<name>.<parent>`. */
export function profileAccount(buyer: BuyerProfile, parent: string): string {
  return `${buyer.name}.${parent}`;
}
