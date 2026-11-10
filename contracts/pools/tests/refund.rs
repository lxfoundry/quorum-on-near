mod common;

use common::*;

/// A pool of 6 seats at 2 mUSD with a 10 mUSD bonus, three buyers with one seat each, then expired.
async fn expired_pool(w: &World) -> anyhow::Result<(u64, AccountId, Vec<AccountId>)> {
    let seller = w.user("seller", 10).await?;
    let buyers = vec![
        w.user("a", 10).await?,
        w.user("b", 10).await?,
        w.user("c", 10).await?,
    ];
    let deadline = w.deadline_in(DEADLINE_MS).await?;
    let id = w
        .open(&seller, 10 * MUSD, 2 * MUSD, 6, deadline, None)
        .await?;
    for buyer in &buyers {
        assert!(w.commit(buyer, id, 1, 2 * MUSD).await?.ok);
    }
    w.expire(id).await?;
    Ok((id, seller, buyers))
}

#[tokio::test]
async fn a_failed_pool_refunds_every_buyer_in_batches_and_the_dust_goes_to_the_seller(
) -> anyhow::Result<()> {
    let w = World::new().await?;
    let (id, seller, buyers) = expired_pool(&w).await?;
    let share = 10 * MUSD / 3; // 3_333_333: the bonus split over 3 seats, floored
    let dust = 10 * MUSD - 3 * share; // 1 base unit

    // first batch: two buyers
    assert!(w.refund(&seller, id, 2, 300).await?.ok);
    w.check_invariants().await?;
    let pool = w.pool(id).await?;
    assert_eq!(pool["status"], "expired");
    assert_eq!(pool["refund_cursor"], 2);
    assert_eq!(w.balance(&buyers[0]).await?, 10 * MUSD + share);
    assert_eq!(w.balance(&buyers[1]).await?, 10 * MUSD + share);
    assert_eq!(w.balance(&buyers[2]).await?, 8 * MUSD, "not refunded yet");

    // second batch: the last buyer, then the dust
    assert!(w.refund(&seller, id, 2, 300).await?.ok);
    w.check_invariants().await?;
    let pool = w.pool(id).await?;
    assert_eq!(pool["status"], "refunded");
    assert_eq!(pool["dust_sent"], true);
    assert_eq!(w.balance(&buyers[2]).await?, 10 * MUSD + share);
    assert_eq!(w.balance(&seller).await?, dust);
    assert_eq!(w.balance(&w.pools).await?, 0);

    // a refunded pool takes no more refund calls
    assert!(!w.refund(&seller, id, 2, 300).await?.ok);
    Ok(())
}

#[tokio::test]
async fn a_dust_of_zero_finishes_without_a_transfer() -> anyhow::Result<()> {
    let w = World::new().await?;
    let seller = w.user("seller", 9).await?;
    let buyers = vec![
        w.user("a", 10).await?,
        w.user("b", 10).await?,
        w.user("c", 10).await?,
    ];
    let deadline = w.deadline_in(DEADLINE_MS).await?;
    // 9 mUSD of bonus over 3 seats divides exactly: 3 mUSD each, nothing left over
    let id = w
        .open(&seller, 9 * MUSD, 2 * MUSD, 6, deadline, None)
        .await?;
    for buyer in &buyers {
        assert!(w.commit(buyer, id, 1, 2 * MUSD).await?.ok);
    }
    w.expire(id).await?;

    assert!(w.refund(&seller, id, 10, 300).await?.ok);
    w.check_invariants().await?;
    let pool = w.pool(id).await?;
    assert_eq!(pool["status"], "refunded", "the pool finished in one call");
    assert_eq!(w.balance(&seller).await?, 0, "no dust was sent");
    assert_eq!(w.balance(&buyers[0]).await?, 10 * MUSD + 3 * MUSD);
    Ok(())
}

#[tokio::test]
async fn a_pool_with_no_seats_returns_the_whole_bonus_to_the_seller() -> anyhow::Result<()> {
    let w = World::new().await?;
    let seller = w.user("seller", 10).await?;
    let deadline = w.deadline_in(DEADLINE_MS).await?;
    let id = w
        .open(&seller, 10 * MUSD, 2 * MUSD, 4, deadline, None)
        .await?;
    w.expire(id).await?;

    assert!(w.refund(&seller, id, 1, 300).await?.ok);
    w.check_invariants().await?;
    assert_eq!(w.pool(id).await?["status"], "refunded");
    assert_eq!(w.balance(&seller).await?, 10 * MUSD);
    Ok(())
}

#[tokio::test]
async fn refund_is_refused_before_the_deadline() -> anyhow::Result<()> {
    let w = World::new().await?;
    let seller = w.user("seller", 10).await?;
    let deadline = w.deadline_in(DEADLINE_MS).await?;
    let id = w
        .open(&seller, 10 * MUSD, 2 * MUSD, 4, deadline, None)
        .await?;
    assert!(!w.refund(&seller, id, 5, 300).await?.ok);
    assert_eq!(w.pool(id).await?["status"], "open");
    Ok(())
}

#[tokio::test]
async fn refund_limits_outside_one_to_ten_are_refused() -> anyhow::Result<()> {
    let w = World::new().await?;
    let (id, seller, _buyers) = expired_pool(&w).await?;
    assert!(!w.refund(&seller, id, 0, 300).await?.ok);
    assert!(!w.refund(&seller, id, 11, 300).await?.ok);
    assert_eq!(w.pool(id).await?["refund_cursor"], 0);
    Ok(())
}

#[tokio::test]
async fn refund_needs_enough_gas_and_changes_nothing_without_it() -> anyhow::Result<()> {
    let w = World::new().await?;
    let (id, seller, buyers) = expired_pool(&w).await?;

    // limit 10 needs gas for 11 transfers and their callbacks; 100 Tgas is not enough
    assert!(!w.refund(&seller, id, 10, 100).await?.ok);
    let pool = w.pool(id).await?;
    assert_eq!(pool["refund_cursor"], 0, "nothing was processed");
    assert_eq!(w.balance(&buyers[0]).await?, 8 * MUSD, "nothing was paid");
    w.check_invariants().await?;

    // the same call with enough gas goes through
    assert!(w.refund(&seller, id, 10, 300).await?.ok);
    assert_eq!(w.pool(id).await?["status"], "refunded");
    w.check_invariants().await?;
    Ok(())
}

#[tokio::test]
async fn a_failed_dust_transfer_is_retried_by_the_next_refund_call() -> anyhow::Result<()> {
    let w = World::new().await?;
    let (id, seller, buyers) = expired_pool(&w).await?;
    let share = 10 * MUSD / 3;

    // the seller leaves the token, so the dust (1 base unit) cannot be sent
    w.unregister(&seller).await?;
    assert!(w.refund(&buyers[0], id, 10, 300).await?.ok);
    let pool = w.pool(id).await?;
    assert_eq!(
        pool["status"], "expired",
        "the dust is still owed, so the pool is not finished"
    );
    assert_eq!(pool["dust_sent"], false);
    for buyer in &buyers {
        assert_eq!(w.balance(buyer).await?, 10 * MUSD + share);
    }
    w.check_invariants().await?;

    // the seller registers again; the next call sends only the dust
    w.register(&seller).await?;
    assert!(w.refund(&buyers[0], id, 1, 300).await?.ok);
    let pool = w.pool(id).await?;
    assert_eq!(pool["status"], "refunded");
    assert_eq!(pool["dust_sent"], true);
    assert_eq!(w.balance(&seller).await?, 1);
    for buyer in &buyers {
        assert_eq!(
            w.balance(buyer).await?,
            10 * MUSD + share,
            "no buyer was paid twice"
        );
    }
    w.check_invariants().await?;
    Ok(())
}
