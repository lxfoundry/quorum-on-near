//! Pure amount functions. Nothing here reads the chain.

pub fn bonus_per_seat(bonus: u128, taken: u32) -> u128 {
    if taken == 0 {
        0
    } else {
        bonus / u128::from(taken)
    }
}

/// What is left of the bonus once every seat has its share; it goes back to the seller.
pub fn dust(bonus: u128, bonus_per_seat: u128, taken: u32) -> u128 {
    let shared = bonus_per_seat
        .checked_mul(u128::from(taken))
        .expect("bonus share overflows");
    bonus
        .checked_sub(shared)
        .expect("bonus shares exceed the bonus")
}

pub fn price_of(seats: u32, seat_price: u128) -> u128 {
    u128::from(seats)
        .checked_mul(seat_price)
        .expect("seat price overflows")
}

/// A buyer's refund: its seats' price plus its seats' share of the bonus.
pub fn refund_amount(seats: u32, seat_price: u128, bonus_per_seat: u128) -> u128 {
    let per_seat = seat_price
        .checked_add(bonus_per_seat)
        .expect("refund overflows");
    u128::from(seats)
        .checked_mul(per_seat)
        .expect("refund overflows")
}

/// What the seller receives when a pool settles: the takings plus the bonus back.
pub fn payout(taken: u32, seat_price: u128, bonus: u128) -> u128 {
    price_of(taken, seat_price)
        .checked_add(bonus)
        .expect("payout overflows")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The least each seat of a failed pool receives, whatever the other buyers do: a failed pool
    /// has at most `target - 1` seats, so this is `floor(bonus / max(target - 1, 1))`.
    fn min_bonus_per_seat(bonus: u128, target: u32) -> u128 {
        bonus / u128::from(target.saturating_sub(1).max(1))
    }

    #[test]
    fn bonus_is_shared_equally_and_floored() {
        assert_eq!(bonus_per_seat(17_280_000, 191), 90_471);
        assert_eq!(bonus_per_seat(10, 3), 3);
        assert_eq!(bonus_per_seat(10, 1), 10);
    }

    #[test]
    fn no_seats_means_no_share() {
        assert_eq!(bonus_per_seat(10, 0), 0);
        assert_eq!(dust(10, 0, 0), 10);
    }

    #[test]
    fn dust_is_the_rounding_remainder() {
        assert_eq!(dust(10, 3, 3), 1);
        assert_eq!(dust(9, 3, 3), 0);
    }

    #[test]
    fn refund_is_price_plus_share_per_seat() {
        assert_eq!(refund_amount(2, 1_800_000, 90_471), 3_780_942);
        assert_eq!(refund_amount(1, 5, 0), 5);
    }

    #[test]
    fn payout_is_the_takings_plus_the_bonus() {
        assert_eq!(payout(192, 1_800_000, 17_280_000), 192 * 1_800_000 + 17_280_000);
    }

    /// The testnet scenarios (spec section 7.3) price seats at a few hundred base units of USDC.
    #[test]
    fn the_testnet_scenario_amounts_add_up() {
        // fills: 192 seats at 180, a bonus of 1,728
        assert_eq!(payout(192, 180, 1_728), 36_288);
        assert_eq!(min_bonus_per_seat(1_728, 192), 9);
        // fails: 192 seats at 320, a bonus of 3,072, expiring with 100 seats taken
        let share = bonus_per_seat(3_072, 100);
        assert_eq!(share, 30);
        assert_eq!(dust(3_072, share, 100), 72);
        assert_eq!(refund_amount(1, 320, share), 350);
        assert_eq!(min_bonus_per_seat(3_072, 192), 16);
    }

    #[test]
    fn refunds_and_dust_always_add_up_to_what_the_pool_holds() {
        for bonus in [0u128, 1, 7, 100, 1_728, 3_072, 17_280_000] {
            for taken in 1u32..=12 {
                let share = bonus_per_seat(bonus, taken);
                let total_refunds: u128 = (0..taken).map(|_| refund_amount(1, 3, share)).sum();
                assert_eq!(total_refunds + dust(bonus, share, taken), u128::from(taken) * 3 + bonus);
            }
        }
    }

    #[test]
    fn a_failed_pool_never_pays_less_than_the_minimum_share() {
        for bonus in [0u128, 1, 7, 100, 1_728, 3_072, 17_280_000] {
            for target in 1u32..=12 {
                // a failed pool has fewer seats taken than its target
                for taken in 1..target {
                    assert!(
                        bonus_per_seat(bonus, taken) >= min_bonus_per_seat(bonus, target),
                        "bonus {bonus}, target {target}, taken {taken}"
                    );
                }
            }
        }
    }

    #[test]
    #[should_panic(expected = "seat price overflows")]
    fn a_price_that_overflows_panics() {
        price_of(2, u128::MAX);
    }

    #[test]
    #[should_panic(expected = "refund overflows")]
    fn a_refund_that_overflows_panics() {
        refund_amount(2, u128::MAX / 2 + 1, 0);
    }

    #[test]
    #[should_panic(expected = "refund overflows")]
    fn a_price_plus_share_that_overflows_panics() {
        refund_amount(1, u128::MAX, 1);
    }

    #[test]
    #[should_panic(expected = "bonus shares exceed the bonus")]
    fn shares_larger_than_the_bonus_panic() {
        dust(1, 2, 1);
    }

    #[test]
    #[should_panic(expected = "payout overflows")]
    fn a_payout_that_overflows_panics() {
        payout(1, u128::MAX, 1);
    }
}
