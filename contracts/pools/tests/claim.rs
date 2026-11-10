mod common;

use common::*;
use serde_json::json;

const SHARE: u128 = 10 * MUSD / 3; // the 10 mUSD bonus over 3 seats, floored

/// 6 seats at 2 mUSD, a 10 mUSD bonus, three buyers with one seat each, expired.
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
async fn a_buyer_can_claim_before_anyone_has_called_refund() -> anyhow::Result<()> {
    let w = World::new().await?;
    let (id, seller, buyers) = expired_pool(&w).await?;

    assert!(w.claim(&buyers[1], id).await?.ok);
    w.check_invariants().await?;
    assert_eq!(w.balance(&buyers[1]).await?, 10 * MUSD + SHARE);
    let pool = w.pool(id).await?;
    assert_eq!(pool["status"], "expired", "the claim stored the expiry");
    let row = w
        .chain
        .view(
            &w.pools,
            "get_buyer",
            json!({ "pool_id": id, "account_id": buyers[1] }),
        )
        .await?;
    assert_eq!(row["state"], "refunded");

    // refund then skips the buyer that already claimed, and finishes the pool
    assert!(w.refund(&seller, id, 10, 300).await?.ok);
    w.check_invariants().await?;
    assert_eq!(w.pool(id).await?["status"], "refunded");
    assert_eq!(w.balance(&buyers[0]).await?, 10 * MUSD + SHARE);
    assert_eq!(
        w.balance(&buyers[1]).await?,
        10 * MUSD + SHARE,
        "paid once, not twice"
    );
    assert_eq!(w.balance(&buyers[2]).await?, 10 * MUSD + SHARE);

    // claiming again is refused
    assert!(!w.claim(&buyers[1], id).await?.ok);
    assert_eq!(w.balance(&buyers[1]).await?, 10 * MUSD + SHARE);
    Ok(())
}

#[tokio::test]
async fn a_refund_that_cannot_be_pushed_becomes_claimable() -> anyhow::Result<()> {
    let w = World::new().await?;
    let (id, seller, buyers) = expired_pool(&w).await?;

    // buyer b leaves the token, so the pushed refund to it fails
    w.unregister(&buyers[1]).await?;
    assert!(w.refund(&seller, id, 10, 300).await?.ok);
    w.check_invariants().await?;

    let row = w
        .chain
        .view(
            &w.pools,
            "get_buyer",
            json!({ "pool_id": id, "account_id": buyers[1] }),
        )
        .await?;
    assert_eq!(row["state"], "claimable");
    assert_eq!(
        w.pool(id).await?["status"],
        "refunded",
        "the pool is done; one refund is still owed"
    );
    assert_eq!(w.balance(&buyers[0]).await?, 10 * MUSD + SHARE);

    // b registers again and claims
    w.register(&buyers[1]).await?;
    assert!(w.claim(&buyers[1], id).await?.ok);
    w.check_invariants().await?;
    // leaving the token burned b's remaining 8 mUSD, so b now holds only the refund
    assert_eq!(w.balance(&buyers[1]).await?, 2 * MUSD + SHARE);
    let row = w
        .chain
        .view(
            &w.pools,
            "get_buyer",
            json!({ "pool_id": id, "account_id": buyers[1] }),
        )
        .await?;
    assert_eq!(row["state"], "refunded");
    Ok(())
}

#[tokio::test]
async fn a_failed_claim_leaves_the_refund_claimable() -> anyhow::Result<()> {
    let w = World::new().await?;
    let (id, _seller, buyers) = expired_pool(&w).await?;

    w.unregister(&buyers[0]).await?;
    assert!(
        w.claim(&buyers[0], id).await?.ok,
        "the call succeeds; its callback restores the state"
    );
    let row = w
        .chain
        .view(
            &w.pools,
            "get_buyer",
            json!({ "pool_id": id, "account_id": buyers[0] }),
        )
        .await?;
    assert_eq!(row["state"], "claimable");
    w.check_invariants().await?;

    w.register(&buyers[0]).await?;
    assert!(w.claim(&buyers[0], id).await?.ok);
    // leaving the token burned a's remaining 8 mUSD, so a now holds only the refund
    assert_eq!(w.balance(&buyers[0]).await?, 2 * MUSD + SHARE);
    w.check_invariants().await?;
    Ok(())
}

#[tokio::test]
async fn a_claim_needs_an_expired_pool_and_held_seats() -> anyhow::Result<()> {
    let w = World::new().await?;
    let seller = w.user("seller", 20).await?;
    let a = w.user("a", 10).await?;
    let deadline = w.deadline_in(DEADLINE_MS).await?;
    let id = w
        .open(&seller, 10 * MUSD, 2 * MUSD, 4, deadline, None)
        .await?;
    assert!(w.commit(&a, id, 1, 2 * MUSD).await?.ok);

    // the pool is still open: no claim
    assert!(!w.claim(&a, id).await?.ok);
    assert_eq!(w.balance(&a).await?, 8 * MUSD);

    // an expired pool where the caller holds no seats: a second pool in the same world
    let deadline2 = w.deadline_in(DEADLINE_MS).await?;
    let id2 = w
        .open(&seller, 10 * MUSD, 2 * MUSD, 4, deadline2, None)
        .await?;
    w.expire(id2).await?;
    assert!(
        !w.claim(&a, id2).await?.ok,
        "a holds no seats in the second pool"
    );
    w.check_invariants().await?;
    Ok(())
}
