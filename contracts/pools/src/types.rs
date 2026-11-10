use near_sdk::json_types::U128;
use near_sdk::{near, AccountId};

use crate::math;

pub const MAX_TARGET: u32 = 1000;
pub const MAX_TERMS_BYTES: usize = 280;
pub const MAX_REFUND_LIMIT: u32 = 10;
/// The most rows a view returns in one call.
pub const MAX_PAGE: u64 = 100;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum PoolStatus {
    Open,
    Filled,
    Settled,
    Expired,
    Refunded,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum BuyerState {
    Committed,
    Refunded,
    Claimable,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Pool {
    pub seller: AccountId,
    pub seat_price: u128,
    pub target: u32,
    pub taken: u32,
    pub deadline_ms: u64,
    pub bonus: u128,
    pub max_seats_per_buyer: Option<u32>,
    pub terms: String,
    pub status: PoolStatus,
    /// Fixed when the pool expires; 0 before that.
    pub bonus_per_seat: u128,
    /// The next buyer slot `refund` will look at.
    pub refund_cursor: u32,
    pub dust_sent: bool,
    pub buyer_count: u32,
}

impl Pool {
    /// Moves an Open pool that is past its deadline to Expired and fixes the bonus share.
    pub fn expire_if_due(&mut self, now_ms: u64) {
        if self.status == PoolStatus::Open && now_ms >= self.deadline_ms {
            self.status = PoolStatus::Expired;
            self.bonus_per_seat = math::bonus_per_seat(self.bonus, self.taken);
        }
    }
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Buyer {
    /// This buyer's position in the pool's commit order.
    pub slot: u32,
    pub seats: u32,
    pub state: BuyerState,
}

/// The messages `ft_on_transfer` accepts, as JSON: `{"open": {...}}` or `{"commit": {...}}`.
#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
pub enum Msg {
    Open {
        seat_price: U128,
        target: u32,
        deadline_ms: u64,
        max_seats_per_buyer: Option<u32>,
        terms: String,
    },
    Commit {
        pool_id: u64,
        seats: u32,
    },
}

pub struct OpenParams {
    pub seat_price: u128,
    pub target: u32,
    pub deadline_ms: u64,
    pub max_seats_per_buyer: Option<u32>,
    pub terms: String,
}

/// A pool as the views report it. The status is derived from block time, so a pool past its
/// deadline reads as Expired even before any call has stored that.
#[near(serializers = [json])]
pub struct PoolView {
    pub id: u64,
    pub seller: AccountId,
    pub seat_price: U128,
    pub target: u32,
    pub taken: u32,
    pub deadline_ms: u64,
    pub bonus: U128,
    pub max_seats_per_buyer: Option<u32>,
    pub terms: String,
    pub status: PoolStatus,
    pub bonus_per_seat: U128,
    pub refund_cursor: u32,
    pub dust_sent: bool,
    pub buyer_count: u32,
}

impl PoolView {
    pub fn new(id: u64, pool: &Pool, now_ms: u64) -> Self {
        let expires_now = pool.status == PoolStatus::Open && now_ms >= pool.deadline_ms;
        let (status, bonus_per_seat) = if expires_now {
            (
                PoolStatus::Expired,
                math::bonus_per_seat(pool.bonus, pool.taken),
            )
        } else {
            (pool.status, pool.bonus_per_seat)
        };
        Self {
            id,
            seller: pool.seller.clone(),
            seat_price: U128(pool.seat_price),
            target: pool.target,
            taken: pool.taken,
            deadline_ms: pool.deadline_ms,
            bonus: U128(pool.bonus),
            max_seats_per_buyer: pool.max_seats_per_buyer,
            terms: pool.terms.clone(),
            status,
            bonus_per_seat: U128(bonus_per_seat),
            refund_cursor: pool.refund_cursor,
            dust_sent: pool.dust_sent,
            buyer_count: pool.buyer_count,
        }
    }
}

#[near(serializers = [json])]
pub struct SeatView {
    pub buyer: AccountId,
    pub seats: u32,
    pub state: BuyerState,
}

#[near(serializers = [json])]
pub struct BuyerView {
    pub seats: u32,
    pub state: BuyerState,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pool(status: PoolStatus) -> Pool {
        Pool {
            seller: "seller.test".parse().unwrap(),
            seat_price: 2,
            target: 4,
            taken: 3,
            deadline_ms: 1_000,
            bonus: 10,
            max_seats_per_buyer: None,
            terms: String::new(),
            status,
            bonus_per_seat: 0,
            refund_cursor: 0,
            dust_sent: false,
            buyer_count: 3,
        }
    }

    #[test]
    fn an_open_pool_expires_exactly_at_its_deadline() {
        let mut p = pool(PoolStatus::Open);
        p.expire_if_due(999);
        assert_eq!(p.status, PoolStatus::Open);
        p.expire_if_due(1_000);
        assert_eq!(p.status, PoolStatus::Expired);
        assert_eq!(p.bonus_per_seat, 3);
    }

    #[test]
    fn a_filled_pool_never_expires() {
        let mut p = pool(PoolStatus::Filled);
        p.expire_if_due(5_000);
        assert_eq!(p.status, PoolStatus::Filled);
    }

    #[test]
    fn the_view_reports_expiry_without_storing_it() {
        let p = pool(PoolStatus::Open);
        let v = PoolView::new(0, &p, 2_000);
        assert_eq!(v.status, PoolStatus::Expired);
        assert_eq!(v.bonus_per_seat.0, 3);
        assert_eq!(p.status, PoolStatus::Open);
    }
}
