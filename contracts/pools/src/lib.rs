//! Pools escrow. A seller opens a pool (seats, a seat price, a deadline) and escrows a refund bonus.
//! Buyers commit seats. A full pool pays the seller; a pool that misses its deadline refunds every
//! buyer its price plus a share of the bonus. The contract has no owner or admin methods.

mod events;
mod gas;
mod math;
mod receive;
mod refund;
mod settle;
mod types;
mod views;

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    ext_contract, near, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise,
};

pub use types::*;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Pools,
    Slots,
    Buyers,
}

/// The one method of the token this contract calls.
#[ext_contract(ext_token)]
pub trait Token {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    token: AccountId,
    next_pool_id: u64,
    pools: LookupMap<u64, Pool>,
    /// `(pool, slot)` to the buyer in that position of the commit order.
    slots: LookupMap<(u64, u32), AccountId>,
    /// `(pool, buyer)` to that buyer's record.
    buyers: LookupMap<(u64, AccountId), Buyer>,
}

#[near]
impl Contract {
    /// Sets the one token this contract accepts. Only the contract account itself can call it, and
    /// the deployment runs it in the same transaction, so nobody else can choose the token.
    #[init]
    #[private]
    pub fn new(token: AccountId) -> Self {
        Self {
            token,
            next_pool_id: 0,
            pools: LookupMap::new(StorageKey::Pools),
            slots: LookupMap::new(StorageKey::Slots),
            buyers: LookupMap::new(StorageKey::Buyers),
        }
    }
}

impl Contract {
    /// An `ft_transfer` of `amount` to `receiver`, with the 1 yoctoNEAR the token requires, paid
    /// from this contract's own balance.
    pub(crate) fn transfer(token: &AccountId, receiver: AccountId, amount: u128) -> Promise {
        ext_token::ext(token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(gas::TRANSFER_GAS)
            .ft_transfer(receiver, U128(amount), None)
    }
}

#[cfg(test)]
pub(crate) mod testutil {
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{testing_env, AccountId};

    pub fn acct(name: &str) -> AccountId {
        name.parse().unwrap()
    }

    /// Sets who is calling and the block time (milliseconds).
    pub fn set_context(predecessor: &str, now_ms: u64) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(acct(predecessor))
            .block_timestamp(now_ms * 1_000_000)
            .build());
    }

    /// A contract whose token is `token.test`, with the context set to a call from that token.
    pub fn new_contract() -> crate::Contract {
        set_context("token.test", 0);
        crate::Contract::new(acct("token.test"))
    }
}
