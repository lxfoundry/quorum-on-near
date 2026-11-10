use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, PromiseOrValue};

use crate::{events, math};
use crate::{Buyer, BuyerState};
use crate::{
    Contract, ContractExt, Msg, OpenParams, Pool, PoolStatus, MAX_TARGET, MAX_TERMS_BYTES,
};

#[near]
impl Contract {
    /// NEP-141 receiver. The token calls this when someone sends it tokens with
    /// `ft_transfer_call`. A panic here makes the token return the whole amount to the sender.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(
            env::predecessor_account_id() == self.token,
            "only the pool token is accepted"
        );
        let message: Msg = near_sdk::serde_json::from_str(&msg)
            .unwrap_or_else(|_| env::panic_str("invalid message"));
        let now_ms = env::block_timestamp_ms();
        match message {
            Msg::Open {
                seat_price,
                target,
                deadline_ms,
                max_seats_per_buyer,
                terms,
            } => {
                let params = OpenParams {
                    seat_price: seat_price.0,
                    target,
                    deadline_ms,
                    max_seats_per_buyer,
                    terms,
                };
                self.open_pool(sender_id, amount.0, params, now_ms);
                PromiseOrValue::Value(U128(0))
            }
            Msg::Commit { pool_id, seats } => {
                let unused = self.commit_seats(sender_id, amount.0, pool_id, seats, now_ms);
                PromiseOrValue::Value(U128(unused))
            }
        }
    }
}

impl Contract {
    /// Opens a pool for `seller`, which has just escrowed `bonus`. Returns the new pool's id.
    pub(crate) fn open_pool(
        &mut self,
        seller: AccountId,
        bonus: u128,
        p: OpenParams,
        now_ms: u64,
    ) -> u64 {
        require!(p.seat_price > 0, "seat_price must be positive");
        require!(
            (1..=MAX_TARGET).contains(&p.target),
            "target must be between 1 and 1000"
        );
        require!(p.deadline_ms > now_ms, "deadline must be in the future");
        require!(
            p.terms.len() <= MAX_TERMS_BYTES,
            "terms must be at most 280 bytes"
        );
        if let Some(cap) = p.max_seats_per_buyer {
            require!(cap >= 1, "max_seats_per_buyer must be at least 1");
        }
        let id = self.next_pool_id;
        self.next_pool_id = id
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("pool id overflows"));
        events::pool_opened(
            id,
            &seller,
            p.seat_price,
            p.target,
            p.deadline_ms,
            bonus,
            &p.terms,
        );
        self.pools.insert(
            id,
            Pool {
                seller,
                seat_price: p.seat_price,
                target: p.target,
                taken: 0,
                deadline_ms: p.deadline_ms,
                bonus,
                max_seats_per_buyer: p.max_seats_per_buyer,
                terms: p.terms,
                status: PoolStatus::Open,
                bonus_per_seat: 0,
                refund_cursor: 0,
                dust_sent: false,
                buyer_count: 0,
            },
        );
        id
    }

    /// Takes `buyer`'s seats in a pool, for a payment of `amount`. Returns the part of the payment
    /// to give back: the price of any requested seats the pool had no room for.
    pub(crate) fn commit_seats(
        &mut self,
        buyer: AccountId,
        amount: u128,
        pool_id: u64,
        seats: u32,
        now_ms: u64,
    ) -> u128 {
        let pool = self
            .pools
            .get_mut(&pool_id)
            .unwrap_or_else(|| env::panic_str("pool not found"));
        require!(pool.status == PoolStatus::Open, "pool is not open");
        require!(now_ms < pool.deadline_ms, "pool is past its deadline");
        require!(
            buyer != pool.seller,
            "the seller cannot commit to its own pool"
        );
        require!(seats >= 1, "seats must be at least 1");
        require!(
            amount == math::price_of(seats, pool.seat_price),
            "amount must equal seats times seat_price"
        );
        let key = (pool_id, buyer.clone());
        let held = self.buyers.get(&key).map_or(0, |b| b.seats);
        if let Some(cap) = pool.max_seats_per_buyer {
            require!(
                held.checked_add(seats).is_some_and(|total| total <= cap),
                "commit exceeds max_seats_per_buyer"
            );
        }
        let taken_now = seats.min(pool.target - pool.taken);
        require!(taken_now > 0, "no seats left");

        match self.buyers.get_mut(&key) {
            Some(record) => record.seats += taken_now,
            None => {
                let slot = pool.buyer_count;
                self.slots.insert((pool_id, slot), buyer.clone());
                self.buyers.insert(
                    key,
                    Buyer {
                        slot,
                        seats: taken_now,
                        state: BuyerState::Committed,
                    },
                );
                pool.buyer_count += 1;
            }
        }
        pool.taken += taken_now;
        events::seats_committed(
            pool_id,
            &buyer,
            taken_now,
            math::price_of(taken_now, pool.seat_price),
            pool.taken,
            pool.target,
        );
        if pool.taken == pool.target {
            pool.status = PoolStatus::Filled;
            events::pool_filled(pool_id, pool.taken);
        }
        math::price_of(seats - taken_now, pool.seat_price)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::*;

    fn params() -> OpenParams {
        OpenParams {
            seat_price: 2_000_000,
            target: 4,
            deadline_ms: 10_000,
            max_seats_per_buyer: None,
            terms: "block".to_string(),
        }
    }

    #[test]
    fn opening_creates_an_open_pool_holding_the_bonus() {
        let mut c = new_contract();
        let id = c.open_pool(acct("seller.test"), 10_000_000, params(), 1_000);
        assert_eq!(id, 0);
        let pool = c.pools.get(&0).unwrap();
        assert_eq!(pool.status, PoolStatus::Open);
        assert_eq!(pool.bonus, 10_000_000);
        assert_eq!(pool.taken, 0);
        assert_eq!(pool.seller, acct("seller.test"));
        assert!(near_sdk::test_utils::get_logs()
            .iter()
            .any(|l| l.starts_with("EVENT_JSON:") && l.contains(r#""event":"pool_opened""#)));
    }

    #[test]
    fn pool_ids_count_up_from_zero() {
        let mut c = new_contract();
        assert_eq!(c.open_pool(acct("seller.test"), 1, params(), 1_000), 0);
        assert_eq!(c.open_pool(acct("seller.test"), 1, params(), 1_000), 1);
    }

    #[test]
    fn a_bonus_of_zero_is_allowed() {
        let mut c = new_contract();
        c.open_pool(acct("seller.test"), 0, params(), 1_000);
        assert_eq!(c.pools.get(&0).unwrap().bonus, 0);
    }

    #[test]
    #[should_panic(expected = "seat_price must be positive")]
    fn a_free_seat_is_refused() {
        let mut c = new_contract();
        let mut p = params();
        p.seat_price = 0;
        c.open_pool(acct("seller.test"), 1, p, 1_000);
    }

    #[test]
    #[should_panic(expected = "target must be between 1 and 1000")]
    fn a_target_of_zero_is_refused() {
        let mut c = new_contract();
        let mut p = params();
        p.target = 0;
        c.open_pool(acct("seller.test"), 1, p, 1_000);
    }

    #[test]
    #[should_panic(expected = "target must be between 1 and 1000")]
    fn a_target_above_the_limit_is_refused() {
        let mut c = new_contract();
        let mut p = params();
        p.target = 1001;
        c.open_pool(acct("seller.test"), 1, p, 1_000);
    }

    #[test]
    #[should_panic(expected = "deadline must be in the future")]
    fn a_deadline_that_is_now_is_refused() {
        let mut c = new_contract();
        let mut p = params();
        p.deadline_ms = 1_000;
        c.open_pool(acct("seller.test"), 1, p, 1_000);
    }

    #[test]
    #[should_panic(expected = "terms must be at most 280 bytes")]
    fn long_terms_are_refused() {
        let mut c = new_contract();
        let mut p = params();
        p.terms = "x".repeat(281);
        c.open_pool(acct("seller.test"), 1, p, 1_000);
    }

    #[test]
    fn terms_of_exactly_280_bytes_are_accepted() {
        let mut c = new_contract();
        let mut p = params();
        p.terms = "x".repeat(280);
        c.open_pool(acct("seller.test"), 1, p, 1_000);
    }

    #[test]
    #[should_panic(expected = "max_seats_per_buyer must be at least 1")]
    fn a_cap_of_zero_is_refused() {
        let mut c = new_contract();
        let mut p = params();
        p.max_seats_per_buyer = Some(0);
        c.open_pool(acct("seller.test"), 1, p, 1_000);
    }

    #[test]
    fn the_message_opens_a_pool_and_returns_nothing_unused() {
        let mut c = new_contract();
        set_context("token.test", 1_000);
        let msg = r#"{"open":{"seat_price":"2000000","target":4,"deadline_ms":10000,"max_seats_per_buyer":2,"terms":"block"}}"#;
        let out = c.ft_on_transfer(acct("seller.test"), U128(10_000_000), msg.to_string());
        match out {
            PromiseOrValue::Value(unused) => assert_eq!(unused.0, 0),
            _ => panic!("expected an immediate value"),
        }
        assert_eq!(c.pools.get(&0).unwrap().max_seats_per_buyer, Some(2));
    }

    #[test]
    #[should_panic(expected = "only the pool token is accepted")]
    fn another_token_is_refused() {
        let mut c = new_contract();
        set_context("other.test", 1_000);
        let _ = c.ft_on_transfer(acct("seller.test"), U128(1), r#"{"open":{}}"#.to_string());
    }

    #[test]
    #[should_panic(expected = "invalid message")]
    fn a_garbled_message_is_refused() {
        let mut c = new_contract();
        set_context("token.test", 1_000);
        let _ = c.ft_on_transfer(acct("seller.test"), U128(1), "not json".to_string());
    }
    fn open_pool_with(c: &mut Contract, target: u32, cap: Option<u32>) -> u64 {
        let mut p = params();
        p.target = target;
        p.max_seats_per_buyer = cap;
        c.open_pool(acct("seller.test"), 10_000_000, p, 1_000)
    }

    #[test]
    fn a_commit_records_the_buyer_and_the_seats() {
        let mut c = new_contract();
        let id = open_pool_with(&mut c, 4, None);
        let unused = c.commit_seats(acct("a.test"), 4_000_000, id, 2, 2_000);
        assert_eq!(unused, 0);
        let pool = c.pools.get(&id).unwrap();
        assert_eq!((pool.taken, pool.buyer_count), (2, 1));
        let buyer = c.buyers.get(&(id, acct("a.test"))).unwrap();
        assert_eq!(
            (buyer.slot, buyer.seats, buyer.state),
            (0, 2, BuyerState::Committed)
        );
        assert_eq!(c.slots.get(&(id, 0)).unwrap(), &acct("a.test"));
    }

    #[test]
    fn a_second_commit_adds_to_the_same_record() {
        let mut c = new_contract();
        let id = open_pool_with(&mut c, 4, None);
        c.commit_seats(acct("a.test"), 2_000_000, id, 1, 2_000);
        c.commit_seats(acct("a.test"), 2_000_000, id, 1, 2_000);
        let pool = c.pools.get(&id).unwrap();
        assert_eq!((pool.taken, pool.buyer_count), (2, 1));
        assert_eq!(c.buyers.get(&(id, acct("a.test"))).unwrap().seats, 2);
    }

    #[test]
    fn buyers_keep_their_commit_order() {
        let mut c = new_contract();
        let id = open_pool_with(&mut c, 4, None);
        c.commit_seats(acct("a.test"), 2_000_000, id, 1, 2_000);
        c.commit_seats(acct("b.test"), 2_000_000, id, 1, 2_000);
        assert_eq!(c.slots.get(&(id, 0)).unwrap(), &acct("a.test"));
        assert_eq!(c.slots.get(&(id, 1)).unwrap(), &acct("b.test"));
    }

    #[test]
    fn the_last_seat_fills_the_pool() {
        let mut c = new_contract();
        let id = open_pool_with(&mut c, 2, None);
        c.commit_seats(acct("a.test"), 2_000_000, id, 1, 2_000);
        c.commit_seats(acct("b.test"), 2_000_000, id, 1, 2_000);
        assert_eq!(c.pools.get(&id).unwrap().status, PoolStatus::Filled);
        let logs = near_sdk::test_utils::get_logs();
        assert!(logs
            .iter()
            .any(|l| l.starts_with("EVENT_JSON:") && l.contains(r#""event":"seats_committed""#)));
        assert!(logs
            .iter()
            .any(|l| l.starts_with("EVENT_JSON:") && l.contains(r#""event":"pool_filled""#)));
    }

    #[test]
    fn paying_for_more_seats_than_are_left_takes_the_rest_and_returns_the_excess() {
        let mut c = new_contract();
        let id = open_pool_with(&mut c, 3, None);
        c.commit_seats(acct("a.test"), 4_000_000, id, 2, 2_000);
        let unused = c.commit_seats(acct("b.test"), 4_000_000, id, 2, 2_000);
        assert_eq!(unused, 2_000_000);
        let pool = c.pools.get(&id).unwrap();
        assert_eq!((pool.taken, pool.status), (3, PoolStatus::Filled));
        assert_eq!(c.buyers.get(&(id, acct("b.test"))).unwrap().seats, 1);
    }

    #[test]
    #[should_panic(expected = "pool not found")]
    fn an_unknown_pool_is_refused() {
        let mut c = new_contract();
        c.commit_seats(acct("a.test"), 2_000_000, 9, 1, 2_000);
    }

    #[test]
    #[should_panic(expected = "pool is not open")]
    fn a_filled_pool_takes_no_more_seats() {
        let mut c = new_contract();
        let id = open_pool_with(&mut c, 1, None);
        c.commit_seats(acct("a.test"), 2_000_000, id, 1, 2_000);
        c.commit_seats(acct("b.test"), 2_000_000, id, 1, 2_000);
    }

    #[test]
    #[should_panic(expected = "pool is past its deadline")]
    fn a_commit_at_the_deadline_is_refused() {
        let mut c = new_contract();
        let id = open_pool_with(&mut c, 4, None);
        c.commit_seats(acct("a.test"), 2_000_000, id, 1, 10_000);
    }

    #[test]
    fn a_commit_just_before_the_deadline_is_accepted() {
        let mut c = new_contract();
        let id = open_pool_with(&mut c, 4, None);
        c.commit_seats(acct("a.test"), 2_000_000, id, 1, 9_999);
    }

    #[test]
    #[should_panic(expected = "the seller cannot commit to its own pool")]
    fn the_seller_cannot_commit() {
        let mut c = new_contract();
        let id = open_pool_with(&mut c, 4, None);
        c.commit_seats(acct("seller.test"), 2_000_000, id, 1, 2_000);
    }

    #[test]
    #[should_panic(expected = "seats must be at least 1")]
    fn zero_seats_are_refused() {
        let mut c = new_contract();
        let id = open_pool_with(&mut c, 4, None);
        c.commit_seats(acct("a.test"), 0, id, 0, 2_000);
    }

    #[test]
    #[should_panic(expected = "amount must equal seats times seat_price")]
    fn the_wrong_amount_is_refused() {
        let mut c = new_contract();
        let id = open_pool_with(&mut c, 4, None);
        c.commit_seats(acct("a.test"), 3_000_000, id, 2, 2_000);
    }

    #[test]
    #[should_panic(expected = "commit exceeds max_seats_per_buyer")]
    fn the_per_buyer_cap_counts_seats_already_held() {
        let mut c = new_contract();
        let id = open_pool_with(&mut c, 8, Some(2));
        c.commit_seats(acct("a.test"), 4_000_000, id, 2, 2_000);
        c.commit_seats(acct("a.test"), 2_000_000, id, 1, 2_000);
    }

    #[test]
    fn the_cap_is_checked_against_the_seats_asked_for_not_the_seats_left() {
        let mut c = new_contract();
        let id = open_pool_with(&mut c, 3, Some(3));
        c.commit_seats(acct("a.test"), 4_000_000, id, 2, 2_000);
        // asks for 3 (within the cap of 3), only 1 is left: takes 1, returns the rest
        let unused = c.commit_seats(acct("b.test"), 6_000_000, id, 3, 2_000);
        assert_eq!(unused, 4_000_000);
    }

    #[test]
    fn the_commit_message_reaches_commit_seats() {
        let mut c = new_contract();
        let id = open_pool_with(&mut c, 4, None);
        set_context("token.test", 2_000);
        let msg = format!(r#"{{"commit":{{"pool_id":{id},"seats":2}}}}"#);
        let out = c.ft_on_transfer(acct("a.test"), U128(4_000_000), msg);
        match out {
            PromiseOrValue::Value(unused) => assert_eq!(unused.0, 0),
            _ => panic!("expected an immediate value"),
        }
        assert_eq!(c.pools.get(&id).unwrap().taken, 2);
    }
}
