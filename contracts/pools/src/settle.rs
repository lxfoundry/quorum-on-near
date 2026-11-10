use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, Promise, PromiseError};

use crate::gas::{require_gas_for, CALLBACK_GAS};
use crate::{events, math};
use crate::{Contract, ContractExt, PoolStatus};

#[near]
impl Contract {
    /// Pays a filled pool's seller the takings plus the bonus. Anyone can call it. The pool is marked
    /// Settled before the transfer, so a second call cannot pay twice; if the transfer fails, the
    /// callback puts the pool back to Filled and the call can be repeated.
    pub fn settle(&mut self, pool_id: u64) -> Promise {
        require_gas_for(1);
        let pool = self
            .pools
            .get_mut(&pool_id)
            .unwrap_or_else(|| env::panic_str("pool not found"));
        require!(pool.status == PoolStatus::Filled, "pool is not filled");
        let amount = math::payout(pool.taken, pool.seat_price, pool.bonus);
        let seller = pool.seller.clone();
        pool.status = PoolStatus::Settled;
        Self::transfer(&self.token, seller.clone(), amount).then(
            Self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS)
                .on_settled(pool_id, seller, U128(amount)),
        )
    }

    #[private]
    pub fn on_settled(
        &mut self,
        pool_id: u64,
        seller: AccountId,
        amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        match result {
            Ok(()) => events::pool_settled(pool_id, &seller, amount.0),
            Err(_) => {
                if let Some(pool) = self.pools.get_mut(&pool_id) {
                    if pool.status == PoolStatus::Settled {
                        pool.status = PoolStatus::Filled;
                    }
                }
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

    /// A pool of 2 seats at a price of 2 with a bonus of 10, not yet filled.
    fn open(c: &mut Contract) -> u64 {
        c.open_pool(
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
        )
    }

    fn filled(c: &mut Contract) -> u64 {
        let id = open(c);
        c.commit_seats(acct("a.test"), 2, id, 1, 2_000);
        c.commit_seats(acct("b.test"), 2, id, 1, 2_000);
        id
    }

    #[test]
    fn settle_marks_the_pool_settled_before_the_payout_is_known() {
        let mut c = new_contract();
        let id = filled(&mut c);
        set_context("anyone.test", 3_000);
        let _ = c.settle(id);
        assert_eq!(c.pools.get(&id).unwrap().status, PoolStatus::Settled);
    }

    #[test]
    #[should_panic(expected = "pool is not filled")]
    fn settle_refuses_a_pool_that_is_not_filled() {
        let mut c = new_contract();
        let id = open(&mut c);
        set_context("anyone.test", 3_000);
        let _ = c.settle(id);
    }

    #[test]
    #[should_panic(expected = "pool is not filled")]
    fn settle_refuses_a_pool_that_is_already_settled() {
        let mut c = new_contract();
        let id = filled(&mut c);
        set_context("anyone.test", 3_000);
        let _ = c.settle(id);
        let _ = c.settle(id);
    }

    #[test]
    #[should_panic(expected = "pool not found")]
    fn settle_refuses_an_unknown_pool() {
        let mut c = new_contract();
        set_context("anyone.test", 3_000);
        let _ = c.settle(9);
    }

    #[test]
    fn a_failed_payout_puts_the_pool_back_to_filled() {
        let mut c = new_contract();
        let id = filled(&mut c);
        set_context("anyone.test", 3_000);
        let _ = c.settle(id);
        c.on_settled(id, acct("seller.test"), U128(14), Err(PromiseError::Failed));
        assert_eq!(c.pools.get(&id).unwrap().status, PoolStatus::Filled);
    }

    #[test]
    fn a_successful_payout_leaves_the_pool_settled_and_logs_the_event() {
        let mut c = new_contract();
        let id = filled(&mut c);
        set_context("anyone.test", 3_000);
        let _ = c.settle(id);
        c.on_settled(id, acct("seller.test"), U128(14), Ok(()));
        assert_eq!(c.pools.get(&id).unwrap().status, PoolStatus::Settled);
        assert!(get_logs().iter().any(|line| line.contains("pool_settled")));
    }

    #[test]
    fn a_failure_callback_changes_nothing_unless_the_pool_is_settled() {
        let mut c = new_contract();
        let id = filled(&mut c);
        c.on_settled(id, acct("seller.test"), U128(14), Err(PromiseError::Failed));
        assert_eq!(c.pools.get(&id).unwrap().status, PoolStatus::Filled);
        let open_id = open(&mut c);
        c.on_settled(open_id, acct("seller.test"), U128(14), Err(PromiseError::Failed));
        assert_eq!(c.pools.get(&open_id).unwrap().status, PoolStatus::Open);
    }
}
