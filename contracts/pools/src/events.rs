//! NEP-297 events. Amounts are decimal strings.

use near_sdk::serde_json::{json, Value};
use near_sdk::{env, AccountId};

fn emit(event: &str, data: Value) {
    let body = json!({
        "standard": "quorum",
        "version": "1.0.0",
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{body}"));
}

pub fn pool_opened(
    pool_id: u64,
    seller: &AccountId,
    seat_price: u128,
    target: u32,
    deadline_ms: u64,
    bonus: u128,
    terms: &str,
) {
    emit(
        "pool_opened",
        json!({
            "pool_id": pool_id, "seller": seller, "seat_price": seat_price.to_string(),
            "target": target, "deadline_ms": deadline_ms, "bonus": bonus.to_string(),
            "terms": terms,
        }),
    );
}

pub fn seats_committed(
    pool_id: u64,
    buyer: &AccountId,
    seats: u32,
    amount: u128,
    taken: u32,
    target: u32,
) {
    emit(
        "seats_committed",
        json!({
            "pool_id": pool_id, "buyer": buyer, "seats": seats, "amount": amount.to_string(),
            "taken": taken, "target": target,
        }),
    );
}

pub fn pool_filled(pool_id: u64, taken: u32) {
    emit("pool_filled", json!({ "pool_id": pool_id, "taken": taken }));
}

pub fn pool_settled(pool_id: u64, seller: &AccountId, amount: u128) {
    emit(
        "pool_settled",
        json!({ "pool_id": pool_id, "seller": seller, "amount": amount.to_string() }),
    );
}

pub fn seat_refunded(pool_id: u64, buyer: &AccountId, seats: u32, amount: u128, bonus_share: u128) {
    emit(
        "seat_refunded",
        json!({
            "pool_id": pool_id, "buyer": buyer, "seats": seats, "amount": amount.to_string(),
            "bonus_share": bonus_share.to_string(),
        }),
    );
}

pub fn refund_failed(pool_id: u64, buyer: &AccountId, amount: u128) {
    emit(
        "refund_failed",
        json!({ "pool_id": pool_id, "buyer": buyer, "amount": amount.to_string() }),
    );
}

pub fn refund_claimed(pool_id: u64, buyer: &AccountId, amount: u128) {
    emit(
        "refund_claimed",
        json!({ "pool_id": pool_id, "buyer": buyer, "amount": amount.to_string() }),
    );
}

pub fn pool_refunded(pool_id: u64, dust: u128) {
    emit(
        "pool_refunded",
        json!({ "pool_id": pool_id, "dust": dust.to_string() }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::get_logs;

    /// The JSON after the `EVENT_JSON:` prefix, compared as a value so key order does not matter.
    fn payload(log: &str) -> Value {
        let body = log.strip_prefix("EVENT_JSON:").expect("an event log line");
        near_sdk::serde_json::from_str(body).expect("valid JSON")
    }

    #[test]
    fn events_carry_the_standard_and_string_amounts() {
        pool_filled(7, 192);
        pool_settled(7, &"seller.test".parse().unwrap(), 12_345);
        let logs = get_logs();
        assert_eq!(
            payload(&logs[0]),
            json!({
                "standard": "quorum", "version": "1.0.0", "event": "pool_filled",
                "data": [{ "pool_id": 7, "taken": 192 }],
            })
        );
        assert_eq!(payload(&logs[1])["data"][0]["amount"], "12345");
    }
}
