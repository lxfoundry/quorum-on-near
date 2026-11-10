mod common;

use common::*;

/// `refund` with `limit = 10` asserts that 263 Tgas (plus what it has already used) is available.
/// Called with 262 Tgas it is refused before anything changes. Called with 280 Tgas, just over what
/// it needs, ten refunds and the dust must all complete: if an allowance were too small, a transfer
/// or its callback would run out of gas and a buyer would be left unpaid or stuck. Each transfer and
/// each callback must also burn less than half of its 10 Tgas allowance.
#[tokio::test]
async fn a_full_refund_batch_completes_with_just_over_the_gas_it_needs() -> anyhow::Result<()> {
    let w = World::new().await?;
    // 11 mUSD, of which 10_000_007 base units go in as the bonus: over 10 seats that is 1_000_000
    // each with a dust of 7, so the dust transfer is exercised as well as the ten refunds.
    let seller = w.user("seller", 11).await?;
    let bonus = 10 * MUSD + 7;
    let deadline = w.deadline_in(DEADLINE_MS).await?;
    let id = w.open(&seller, bonus, 2 * MUSD, 20, deadline, None).await?;

    let mut buyers = Vec::new();
    for n in 0..10 {
        let buyer = w.user(&format!("buyer{n}"), 4).await?;
        assert!(w.commit(&buyer, id, 1, 2 * MUSD).await?.ok);
        buyers.push(buyer);
    }
    w.expire(id).await?;

    // under the requirement plus what the call uses before its check: refused, nothing processed
    let out = w.refund(&seller, id, 10, 262).await?;
    assert!(!out.ok, "{}", out.debug);
    assert!(out.debug.contains("not enough gas"), "{}", out.debug);
    assert_eq!(w.pool(id).await?["refund_cursor"], 0);

    let out = w.refund(&seller, id, 10, 280).await?;
    assert!(out.ok, "{}", out.debug);
    w.check_invariants().await?;

    // after the call's own receipt: eleven transfers on the token and a callback for each on the
    // pools contract (the rest are gas refunds to the caller)
    let scheduled: Vec<_> = out
        .receipts
        .iter()
        .skip(1)
        .filter(|(on, _)| *on == w.token || *on == w.pools)
        .collect();
    assert_eq!(out.receipts[0].0, w.pools);
    assert_eq!(scheduled.len(), 22, "{:?}", out.receipts);
    for (on, burnt) in scheduled {
        assert!(
            *burnt < 5_000_000_000_000,
            "a receipt on {on} burnt {burnt} gas"
        );
    }

    let share = bonus / 10;
    for buyer in &buyers {
        assert_eq!(
            w.balance(buyer).await?,
            4 * MUSD - 2 * MUSD + 2 * MUSD + share
        );
        let row = w
            .chain
            .view(
                &w.pools,
                "get_buyer",
                serde_json::json!({ "pool_id": id, "account_id": buyer }),
            )
            .await?;
        assert_eq!(row["state"], "refunded");
    }
    assert_eq!(w.pool(id).await?["status"], "refunded");
    // the seller kept 11 mUSD - 10_000_007 and got the 7 base units of dust back
    assert_eq!(w.balance(&seller).await?, MUSD);
    assert_eq!(w.balance(&w.pools).await?, 0);
    Ok(())
}
