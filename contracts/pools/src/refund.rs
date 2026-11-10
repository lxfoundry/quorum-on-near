use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, PromiseError};

use crate::gas::{require_gas_for, CALLBACK_GAS};
use crate::{events, math};
use crate::{BuyerState, Contract, ContractExt, PoolStatus, MAX_REFUND_LIMIT};

/// One buyer's refund, worked out before any promise is scheduled.
struct Push {
    buyer: AccountId,
    seats: u32,
    amount: u128,
    bonus_share: u128,
}

#[near]
impl Contract {
    /// Refunds up to `limit` buyers of a pool that missed its deadline, then sends the dust to the
    /// seller. Anyone can call it, and calling it again is safe. The first call turns an Open pool
    /// that is past its deadline into Expired and fixes each seat's share of the bonus.
    pub fn refund(&mut self, pool_id: u64, limit: u32) {
        require!(
            (1..=MAX_REFUND_LIMIT).contains(&limit),
            "limit must be between 1 and 10"
        );
        // one transfer per buyer visited, plus the dust transfer
        require_gas_for(limit + 1);
        let now_ms = env::block_timestamp_ms();
        let pool = self
            .pools
            .get_mut(&pool_id)
            .unwrap_or_else(|| env::panic_str("pool not found"));
        pool.expire_if_due(now_ms);
        require!(pool.status == PoolStatus::Expired, "pool is not expired");

        let mut pushes: Vec<Push> = Vec::new();
        let mut visited = 0;
        while visited < limit && pool.refund_cursor < pool.buyer_count {
            let slot = pool.refund_cursor;
            pool.refund_cursor += 1;
            visited += 1;
            let buyer_id = self
                .slots
                .get(&(pool_id, slot))
                .unwrap_or_else(|| env::panic_str("missing buyer slot"))
                .clone();
            let record = self
                .buyers
                .get_mut(&(pool_id, buyer_id.clone()))
                .unwrap_or_else(|| env::panic_str("missing buyer record"));
            if record.state != BuyerState::Committed {
                continue; // already paid, or claimed on its own
            }
            record.state = BuyerState::Refunded;
            pushes.push(Push {
                buyer: buyer_id,
                seats: record.seats,
                amount: math::refund_amount(record.seats, pool.seat_price, pool.bonus_per_seat),
                bonus_share: math::price_of(record.seats, pool.bonus_per_seat),
            });
        }

        // Every buyer has been visited: settle the seller's dust. A dust of zero is not sent,
        // because the token rejects a zero transfer; the pool is simply finished.
        let mut dust_to_send: Option<(AccountId, u128)> = None;
        let mut finished_with_no_dust = false;
        if pool.refund_cursor == pool.buyer_count && !pool.dust_sent {
            let dust = math::dust(pool.bonus, pool.bonus_per_seat, pool.taken);
            pool.dust_sent = true;
            if dust == 0 {
                pool.status = PoolStatus::Refunded;
                finished_with_no_dust = true;
            } else {
                dust_to_send = Some((pool.seller.clone(), dust));
            }
        }

        for push in pushes {
            Self::transfer(&self.token, push.buyer.clone(), push.amount)
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(CALLBACK_GAS)
                        .on_refund_sent(
                            pool_id,
                            push.buyer,
                            push.seats,
                            U128(push.amount),
                            U128(push.bonus_share),
                        ),
                )
                .detach();
        }
        if let Some((seller, dust)) = dust_to_send {
            Self::transfer(&self.token, seller, dust)
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(CALLBACK_GAS)
                        .on_dust_sent(pool_id, U128(dust)),
                )
                .detach();
        }
        if finished_with_no_dust {
            events::pool_refunded(pool_id, 0);
        }
    }

    /// A buyer collects its own refund from a pool that missed its deadline. It works whether or not
    /// anyone has called `refund`, and it is how a buyer recovers a refund that could not be pushed
    /// (for example, because the buyer was not registered on the token). The state is set before the
    /// transfer; if the transfer fails, the callback makes the refund claimable again.
    pub fn claim_refund(&mut self, pool_id: u64) {
        require_gas_for(1);
        let buyer = env::predecessor_account_id();
        let now_ms = env::block_timestamp_ms();
        let pool = self
            .pools
            .get_mut(&pool_id)
            .unwrap_or_else(|| env::panic_str("pool not found"));
        pool.expire_if_due(now_ms);
        require!(
            matches!(pool.status, PoolStatus::Expired | PoolStatus::Refunded),
            "pool is neither expired nor refunded"
        );
        let record = self
            .buyers
            .get_mut(&(pool_id, buyer.clone()))
            .unwrap_or_else(|| env::panic_str("the caller holds no seats in this pool"));
        require!(
            matches!(record.state, BuyerState::Committed | BuyerState::Claimable),
            "the refund was already paid or is on its way"
        );
        record.state = BuyerState::Refunded;
        let amount = math::refund_amount(record.seats, pool.seat_price, pool.bonus_per_seat);
        Self::transfer(&self.token, buyer.clone(), amount)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(CALLBACK_GAS)
                    .on_claim_sent(pool_id, buyer, U128(amount)),
            )
            .detach();
    }

    #[private]
    pub fn on_claim_sent(
        &mut self,
        pool_id: u64,
        buyer: AccountId,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        match result {
            Ok(()) => events::refund_claimed(pool_id, &buyer, amount.0),
            Err(_) => self.restore_claimable(pool_id, &buyer),
        }
    }

    #[private]
    pub fn on_refund_sent(
        &mut self,
        pool_id: u64,
        buyer: AccountId,
        seats: u32,
        amount: U128,
        bonus_share: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        match result {
            Ok(()) => events::seat_refunded(pool_id, &buyer, seats, amount.0, bonus_share.0),
            Err(_) => {
                self.restore_claimable(pool_id, &buyer);
                events::refund_failed(pool_id, &buyer, amount.0);
            }
        }
    }

    #[private]
    pub fn on_dust_sent(
        &mut self,
        pool_id: u64,
        dust: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        if let Some(pool) = self.pools.get_mut(&pool_id) {
            if pool.status != PoolStatus::Expired || !pool.dust_sent {
                return;
            }
            match result {
                Ok(()) => {
                    pool.status = PoolStatus::Refunded;
                    events::pool_refunded(pool_id, dust.0);
                }
                // The pool stays Expired and the next `refund` call retries only the dust.
                Err(_) => pool.dust_sent = false,
            }
        }
    }
}

impl Contract {
    /// Makes a refund claimable again after its transfer failed. It changes nothing unless the
    /// buyer's record exists and is marked Refunded, and it never panics.
    fn restore_claimable(&mut self, pool_id: u64, buyer: &AccountId) {
        if let Some(record) = self.buyers.get_mut(&(pool_id, buyer.clone())) {
            if record.state == BuyerState::Refunded {
                record.state = BuyerState::Claimable;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::*;
    use crate::OpenParams;
    use near_sdk::test_utils::get_logs;

    /// A pool of 6 seats at a price of 2 with the given bonus and a deadline of 10_000, holding one
    /// seat for each named buyer.
    fn pool_with(c: &mut Contract, bonus: u128, buyers: &[&str]) -> u64 {
        let id = c.open_pool(
            acct("seller.test"),
            bonus,
            OpenParams {
                seat_price: 2,
                target: 6,
                deadline_ms: 10_000,
                max_seats_per_buyer: None,
                terms: String::new(),
            },
            1_000,
        );
        for name in buyers {
            c.commit_seats(acct(name), 2, id, 1, 2_000);
        }
        id
    }

    fn state(c: &Contract, id: u64, name: &str) -> BuyerState {
        c.buyers.get(&(id, acct(name))).unwrap().state
    }

    fn logged(fragment: &str) -> bool {
        get_logs().iter().any(|line| line.contains(fragment))
    }

    /// A pool of 2 seats at a price of 2 with a bonus of 10 that is filled by `a` and `b`.
    fn filled_pool(c: &mut Contract) -> u64 {
        let id = c.open_pool(
            acct("seller.test"),
            10,
            OpenParams {
                seat_price: 2,
                target: 2,
                deadline_ms: 10_000,
                max_seats_per_buyer: None,
                terms: String::new(),
            },
            1_000,
        );
        c.commit_seats(acct("a.test"), 2, id, 1, 2_000);
        c.commit_seats(acct("b.test"), 2, id, 1, 2_000);
        id
    }

    #[test]
    #[should_panic(expected = "pool is not expired")]
    fn refund_refuses_a_filled_pool_past_its_deadline() {
        let mut c = new_contract();
        let id = filled_pool(&mut c);
        set_context("anyone.test", 10_000);
        c.refund(id, 5);
    }

    #[test]
    #[should_panic(expected = "pool is not expired")]
    fn refund_refuses_a_settled_pool() {
        let mut c = new_contract();
        let id = filled_pool(&mut c);
        set_context("anyone.test", 3_000);
        let _ = c.settle(id);
        set_context("anyone.test", 10_000);
        c.refund(id, 5);
    }

    #[test]
    #[should_panic(expected = "pool is neither expired nor refunded")]
    fn claim_refund_refuses_a_filled_pool_past_its_deadline() {
        let mut c = new_contract();
        let id = filled_pool(&mut c);
        set_context("a.test", 10_000);
        c.claim_refund(id);
    }

    #[test]
    #[should_panic(expected = "pool is neither expired nor refunded")]
    fn claim_refund_refuses_a_settled_pool() {
        let mut c = new_contract();
        let id = filled_pool(&mut c);
        set_context("anyone.test", 3_000);
        let _ = c.settle(id);
        set_context("a.test", 10_000);
        c.claim_refund(id);
    }

    #[test]
    #[should_panic(expected = "pool is not expired")]
    fn refund_is_refused_before_the_deadline() {
        let mut c = new_contract();
        let id = pool_with(&mut c, 10, &["a.test"]);
        set_context("anyone.test", 9_999);
        c.refund(id, 5);
    }

    #[test]
    #[should_panic(expected = "limit must be between 1 and 10")]
    fn a_limit_of_zero_is_refused() {
        let mut c = new_contract();
        let id = pool_with(&mut c, 10, &["a.test"]);
        set_context("anyone.test", 10_000);
        c.refund(id, 0);
    }

    #[test]
    #[should_panic(expected = "limit must be between 1 and 10")]
    fn a_limit_above_ten_is_refused() {
        let mut c = new_contract();
        let id = pool_with(&mut c, 10, &["a.test"]);
        set_context("anyone.test", 10_000);
        c.refund(id, 11);
    }

    #[test]
    fn the_first_call_expires_the_pool_and_fixes_the_share() {
        let mut c = new_contract();
        let id = pool_with(&mut c, 10, &["a.test", "b.test", "c.test"]);
        set_context("anyone.test", 10_000);
        c.refund(id, 1);
        let pool = c.pools.get(&id).unwrap();
        assert_eq!(pool.status, PoolStatus::Expired);
        assert_eq!(pool.bonus_per_seat, 3);
        assert_eq!(pool.refund_cursor, 1);
        assert_eq!(state(&c, id, "a.test"), BuyerState::Refunded);
        assert_eq!(state(&c, id, "b.test"), BuyerState::Committed);
    }

    #[test]
    fn a_batch_skips_buyers_that_are_no_longer_committed() {
        let mut c = new_contract();
        let id = pool_with(&mut c, 10, &["a.test", "b.test", "c.test"]);
        c.buyers.get_mut(&(id, acct("b.test"))).unwrap().state = BuyerState::Claimable;
        set_context("anyone.test", 10_000);
        c.refund(id, 10);
        assert_eq!(state(&c, id, "a.test"), BuyerState::Refunded);
        assert_eq!(state(&c, id, "b.test"), BuyerState::Claimable);
        assert_eq!(state(&c, id, "c.test"), BuyerState::Refunded);
        // every buyer was visited, so the dust (10 - 3 * 3 = 1) is on its way
        let pool = c.pools.get(&id).unwrap();
        assert!(pool.dust_sent);
        assert_eq!(pool.status, PoolStatus::Expired);
    }

    #[test]
    fn a_dust_of_zero_finishes_the_pool_without_a_transfer() {
        let mut c = new_contract();
        // 9 over 3 seats divides exactly
        let id = pool_with(&mut c, 9, &["a.test", "b.test", "c.test"]);
        set_context("anyone.test", 10_000);
        c.refund(id, 10);
        let pool = c.pools.get(&id).unwrap();
        assert_eq!(pool.status, PoolStatus::Refunded);
        assert!(pool.dust_sent);
        assert!(logged("pool_refunded") && logged(r#""dust":"0""#));
    }

    #[test]
    fn a_pool_with_a_bonus_of_zero_refunds_the_prices_and_finishes() {
        let mut c = new_contract();
        let id = pool_with(&mut c, 0, &["a.test", "b.test"]);
        set_context("anyone.test", 10_000);
        c.refund(id, 10);
        let pool = c.pools.get(&id).unwrap();
        assert_eq!(pool.bonus_per_seat, 0);
        assert_eq!(pool.status, PoolStatus::Refunded);
        assert_eq!(state(&c, id, "a.test"), BuyerState::Refunded);
        assert_eq!(state(&c, id, "b.test"), BuyerState::Refunded);
        assert!(logged("pool_refunded"));
    }

    #[test]
    fn a_pool_with_no_seats_sends_the_whole_bonus_as_dust() {
        let mut c = new_contract();
        let id = pool_with(&mut c, 10, &[]);
        set_context("anyone.test", 10_000);
        c.refund(id, 1);
        let pool = c.pools.get(&id).unwrap();
        assert!(pool.dust_sent);
        assert_eq!(
            pool.status,
            PoolStatus::Expired,
            "the pool finishes when the dust arrives"
        );
    }

    #[test]
    fn a_failed_refund_makes_the_buyer_claimable_and_logs_it() {
        let mut c = new_contract();
        let id = pool_with(&mut c, 10, &["a.test"]);
        set_context("anyone.test", 10_000);
        c.refund(id, 1);
        c.on_refund_sent(
            id,
            acct("a.test"),
            1,
            U128(5),
            U128(3),
            Err(PromiseError::Failed),
        );
        assert_eq!(state(&c, id, "a.test"), BuyerState::Claimable);
        assert!(logged("refund_failed"));
    }

    #[test]
    fn a_paid_refund_logs_the_event_and_keeps_the_state() {
        let mut c = new_contract();
        let id = pool_with(&mut c, 10, &["a.test"]);
        set_context("anyone.test", 10_000);
        c.refund(id, 1);
        c.on_refund_sent(id, acct("a.test"), 1, U128(5), U128(3), Ok(()));
        assert_eq!(state(&c, id, "a.test"), BuyerState::Refunded);
        assert!(logged("seat_refunded"));
    }

    #[test]
    fn a_failed_dust_transfer_lets_the_next_call_retry_only_the_dust() {
        let mut c = new_contract();
        let id = pool_with(&mut c, 10, &["a.test", "b.test", "c.test"]);
        set_context("anyone.test", 10_000);
        c.refund(id, 10);
        c.on_dust_sent(id, U128(1), Err(PromiseError::Failed));
        let pool = c.pools.get(&id).unwrap();
        assert!(!pool.dust_sent);
        assert_eq!(pool.status, PoolStatus::Expired);

        c.refund(id, 1);
        let pool = c.pools.get(&id).unwrap();
        assert!(pool.dust_sent, "the retry sent the dust again");
        assert_eq!(pool.refund_cursor, 3, "and visited no buyer a second time");
    }

    #[test]
    fn a_paid_dust_transfer_finishes_the_pool() {
        let mut c = new_contract();
        let id = pool_with(&mut c, 10, &["a.test", "b.test", "c.test"]);
        set_context("anyone.test", 10_000);
        c.refund(id, 10);
        c.on_dust_sent(id, U128(1), Ok(()));
        assert_eq!(c.pools.get(&id).unwrap().status, PoolStatus::Refunded);
        assert!(logged("pool_refunded"));
    }

    #[test]
    fn a_buyer_can_claim_after_the_deadline_without_any_refund_call() {
        let mut c = new_contract();
        let id = pool_with(&mut c, 10, &["a.test", "b.test", "c.test"]);
        set_context("a.test", 10_000);
        c.claim_refund(id);
        assert_eq!(state(&c, id, "a.test"), BuyerState::Refunded);
        let pool = c.pools.get(&id).unwrap();
        assert_eq!(
            pool.status,
            PoolStatus::Expired,
            "the claim stored the expiry"
        );
        assert_eq!(pool.bonus_per_seat, 3);
        assert_eq!(state(&c, id, "b.test"), BuyerState::Committed);
    }

    #[test]
    #[should_panic(expected = "pool is neither expired nor refunded")]
    fn a_claim_before_the_deadline_is_refused() {
        let mut c = new_contract();
        let id = pool_with(&mut c, 10, &["a.test"]);
        set_context("a.test", 9_999);
        c.claim_refund(id);
    }

    #[test]
    #[should_panic(expected = "the caller holds no seats in this pool")]
    fn a_claim_by_an_account_without_seats_is_refused() {
        let mut c = new_contract();
        let id = pool_with(&mut c, 10, &["a.test"]);
        set_context("stranger.test", 10_000);
        c.claim_refund(id);
    }

    #[test]
    #[should_panic(expected = "the refund was already paid or is on its way")]
    fn a_second_claim_is_refused() {
        let mut c = new_contract();
        let id = pool_with(&mut c, 10, &["a.test"]);
        set_context("a.test", 10_000);
        c.claim_refund(id);
        c.claim_refund(id);
    }

    #[test]
    fn a_claim_whose_transfer_fails_can_be_claimed_again() {
        let mut c = new_contract();
        let id = pool_with(&mut c, 10, &["a.test"]);
        set_context("a.test", 10_000);
        c.claim_refund(id);
        c.on_claim_sent(id, acct("a.test"), U128(5), Err(PromiseError::Failed));
        assert_eq!(state(&c, id, "a.test"), BuyerState::Claimable);
        c.claim_refund(id);
        assert_eq!(state(&c, id, "a.test"), BuyerState::Refunded);
    }

    #[test]
    fn a_paid_claim_logs_the_event_and_keeps_the_state() {
        let mut c = new_contract();
        let id = pool_with(&mut c, 10, &["a.test"]);
        set_context("a.test", 10_000);
        c.claim_refund(id);
        c.on_claim_sent(id, acct("a.test"), U128(5), Ok(()));
        assert_eq!(state(&c, id, "a.test"), BuyerState::Refunded);
        assert!(logged("refund_claimed"));
    }

    #[test]
    fn a_claim_failure_callback_changes_nothing_unless_the_state_is_refunded() {
        let mut c = new_contract();
        let id = pool_with(&mut c, 10, &["a.test"]);
        c.on_claim_sent(id, acct("a.test"), U128(5), Err(PromiseError::Failed));
        assert_eq!(state(&c, id, "a.test"), BuyerState::Committed);
    }

    #[test]
    fn refund_leaves_a_buyer_that_has_already_claimed_alone() {
        let mut c = new_contract();
        let id = pool_with(&mut c, 10, &["a.test", "b.test", "c.test"]);
        set_context("a.test", 10_000);
        c.claim_refund(id);
        set_context("anyone.test", 10_000);
        c.refund(id, 10);
        assert_eq!(state(&c, id, "a.test"), BuyerState::Refunded);
        assert_eq!(state(&c, id, "b.test"), BuyerState::Refunded);
        assert_eq!(state(&c, id, "c.test"), BuyerState::Refunded);
        assert_eq!(c.pools.get(&id).unwrap().refund_cursor, 3);
    }
}
