use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, PromiseOrValue};

use crate::{events, math};
use crate::{Contract, ContractExt, Msg, OpenParams, Pool, PoolStatus, MAX_TARGET, MAX_TERMS_BYTES};

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
            Msg::Commit { .. } => env::panic_str("commit is not implemented yet"),
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
}
