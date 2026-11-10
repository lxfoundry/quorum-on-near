//! Gas the contract sets aside for the transfers and callbacks it schedules. These are the starting
//! allowances, verified against a full refund batch by the sandbox test in tests/gas.rs.

use near_sdk::{env, Gas};

/// Attached to each `ft_transfer` the contract makes.
pub const TRANSFER_GAS: Gas = Gas::from_tgas(10);
/// Reserved for each callback.
pub const CALLBACK_GAS: Gas = Gas::from_tgas(10);
/// The calling method's own work.
pub const BASE_GAS: Gas = Gas::from_tgas(10);
/// Runtime fees for scheduling one transfer and its callback: two function-call receipts and the
/// data receipt between them, about 2.4 Tgas at the runtime's base fees, rounded up.
pub const FEES_PER_TRANSFER: Gas = Gas::from_tgas(3);

/// The gas a call needs in order to schedule `transfers` transfers, each with its callback and their fees.
pub fn gas_needed(transfers: u32) -> u64 {
    BASE_GAS.as_gas()
        + u64::from(transfers)
            * (TRANSFER_GAS.as_gas() + CALLBACK_GAS.as_gas() + FEES_PER_TRANSFER.as_gas())
}

/// Panics, before any state changes, unless the remaining prepaid gas covers `transfers` transfers.
pub fn require_gas_for(transfers: u32) {
    let needed = gas_needed(transfers);
    let left = env::prepaid_gas()
        .as_gas()
        .saturating_sub(env::used_gas().as_gas());
    if left < needed {
        env::panic_str(&format!("not enough gas: need {needed}, have {left}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_transfer_needs_the_base_a_transfer_a_callback_and_their_fees() {
        assert_eq!(gas_needed(1), 33_000_000_000_000);
        assert_eq!(gas_needed(11), 263_000_000_000_000);
    }
}
