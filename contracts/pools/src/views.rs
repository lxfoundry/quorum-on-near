use near_sdk::{env, near, AccountId};

use crate::{BuyerView, Contract, ContractExt, PoolView, SeatView, MAX_PAGE};

#[near]
impl Contract {
    /// Every field of a pool, with the status derived from block time.
    pub fn get_pool(&self, pool_id: u64) -> Option<PoolView> {
        self.pools
            .get(&pool_id)
            .map(|pool| PoolView::new(pool_id, pool, env::block_timestamp_ms()))
    }

    /// Pools in id order, starting at `from`, at most `MAX_PAGE` per call.
    pub fn list_pools(&self, from: u64, limit: u64) -> Vec<PoolView> {
        let end = from
            .saturating_add(limit.min(MAX_PAGE))
            .min(self.next_pool_id);
        (from..end).filter_map(|id| self.get_pool(id)).collect()
    }

    /// A pool's buyers in the order they first committed, at most `MAX_PAGE` per call.
    pub fn get_seats(&self, pool_id: u64, from: u32, limit: u32) -> Vec<SeatView> {
        let Some(pool) = self.pools.get(&pool_id) else {
            return Vec::new();
        };
        let page = u32::try_from(MAX_PAGE).unwrap_or(u32::MAX);
        let end = from.saturating_add(limit.min(page)).min(pool.buyer_count);
        (from..end)
            .map(|slot| {
                let buyer = self
                    .slots
                    .get(&(pool_id, slot))
                    .unwrap_or_else(|| env::panic_str("missing buyer slot"));
                let record = self
                    .buyers
                    .get(&(pool_id, buyer.clone()))
                    .unwrap_or_else(|| env::panic_str("missing buyer record"));
                SeatView {
                    buyer: buyer.clone(),
                    seats: record.seats,
                    state: record.state,
                }
            })
            .collect()
    }

    /// One buyer's seats and state in a pool, or null.
    pub fn get_buyer(&self, pool_id: u64, account_id: AccountId) -> Option<BuyerView> {
        self.buyers
            .get(&(pool_id, account_id))
            .map(|record| BuyerView {
                seats: record.seats,
                state: record.state,
            })
    }

    /// The one token this contract accepts, as set by `new`.
    pub fn get_token(&self) -> AccountId {
        self.token.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::*;
    use crate::{BuyerState, OpenParams, PoolStatus};

    fn open(c: &mut Contract, deadline_ms: u64) -> u64 {
        c.open_pool(
            acct("seller.test"),
            10,
            OpenParams {
                seat_price: 2,
                target: 3,
                deadline_ms,
                max_seats_per_buyer: None,
                terms: "block".to_string(),
            },
            1_000,
        )
    }

    #[test]
    fn an_unknown_pool_reads_as_null() {
        let c = new_contract();
        assert!(c.get_pool(0).is_none());
    }

    #[test]
    fn get_pool_reports_open_before_the_deadline_and_expired_after() {
        let mut c = new_contract();
        let id = open(&mut c, 5_000);
        set_context("anyone.test", 4_999);
        assert_eq!(c.get_pool(id).unwrap().status, PoolStatus::Open);
        set_context("anyone.test", 5_000);
        let view = c.get_pool(id).unwrap();
        assert_eq!(view.status, PoolStatus::Expired);
        // nothing was stored by the read
        assert_eq!(c.pools.get(&id).unwrap().status, PoolStatus::Open);
    }

    #[test]
    fn list_pools_pages_in_id_order() {
        let mut c = new_contract();
        for _ in 0..3 {
            open(&mut c, 5_000);
        }
        let ids: Vec<u64> = c.list_pools(1, 10).iter().map(|p| p.id).collect();
        assert_eq!(ids, vec![1, 2]);
        assert!(c.list_pools(5, 10).is_empty());
    }

    #[test]
    fn seats_and_buyer_views_follow_commit_order() {
        let mut c = new_contract();
        let id = open(&mut c, 5_000);
        c.commit_seats(acct("a.test"), 2, id, 1, 2_000);
        c.commit_seats(acct("b.test"), 2, id, 1, 2_000);
        let seats = c.get_seats(id, 0, 10);
        assert_eq!(seats.len(), 2);
        assert_eq!(seats[0].buyer, acct("a.test"));
        assert_eq!(seats[1].buyer, acct("b.test"));
        assert_eq!(c.get_seats(id, 1, 10).len(), 1);
        let one = c.get_buyer(id, acct("b.test")).unwrap();
        assert_eq!((one.seats, one.state), (1, BuyerState::Committed));
        assert!(c.get_buyer(id, acct("nobody.test")).is_none());
    }

    #[test]
    fn views_of_an_unknown_pool_are_empty() {
        let c = new_contract();
        assert!(c.get_seats(7, 0, 10).is_empty());
        assert!(c.get_buyer(7, acct("a.test")).is_none());
    }

    #[test]
    fn get_token_names_the_token_set_by_new() {
        let c = new_contract();
        assert_eq!(c.get_token(), acct("token.test"));
    }
}
