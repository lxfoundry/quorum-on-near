mod common;

use common::*;

async fn filled_pool(w: &World) -> anyhow::Result<(u64, AccountId, AccountId)> {
    let seller = w.user("seller", 10).await?;
    let a = w.user("a", 10).await?;
    let deadline = w.deadline_in(DEADLINE_MS).await?;
    let id = w.open(&seller, 10 * MUSD, 2 * MUSD, 2, deadline, None).await?;
    assert!(w.commit(&a, id, 2, 2 * MUSD).await?.ok);
    assert_eq!(w.pool(id).await?["status"], "filled");
    Ok((id, seller, a))
}

#[tokio::test]
async fn anyone_can_settle_a_filled_pool_and_the_seller_is_paid() -> anyhow::Result<()> {
    let w = World::new().await?;
    let (id, seller, a) = filled_pool(&w).await?;
    let stranger = w.chain.create_account("stranger", 10).await?;

    assert!(w.settle(&stranger, id).await?.ok);
    w.check_invariants().await?;

    assert_eq!(w.pool(id).await?["status"], "settled");
    assert_eq!(w.balance(&seller).await?, 14 * MUSD, "4 mUSD of seats plus the 10 mUSD bonus back");
    assert_eq!(w.balance(&w.pools).await?, 0);
    assert_eq!(w.balance(&a).await?, 6 * MUSD, "a buyer of a settled pool is not refunded");

    // a second settle is refused and moves nothing
    assert!(!w.settle(&stranger, id).await?.ok);
    assert_eq!(w.balance(&seller).await?, 14 * MUSD);
    Ok(())
}

#[tokio::test]
async fn a_pool_that_is_not_filled_cannot_be_settled() -> anyhow::Result<()> {
    let w = World::new().await?;
    let seller = w.user("seller", 10).await?;
    let deadline = w.deadline_in(DEADLINE_MS).await?;
    let id = w.open(&seller, 10 * MUSD, 2 * MUSD, 2, deadline, None).await?;
    assert!(!w.settle(&seller, id).await?.ok);
    assert_eq!(w.pool(id).await?["status"], "open");
    Ok(())
}

#[tokio::test]
async fn a_filled_pool_settles_even_after_its_deadline() -> anyhow::Result<()> {
    let w = World::new().await?;
    let seller = w.user("seller", 10).await?;
    let a = w.user("a", 10).await?;
    let deadline = w.deadline_in(DEADLINE_MS).await?;
    let id = w.open(&seller, 10 * MUSD, 2 * MUSD, 1, deadline, None).await?;
    assert!(w.commit(&a, id, 1, 2 * MUSD).await?.ok);

    w.expire(id).await?;
    assert_eq!(w.pool(id).await?["status"], "filled", "a full pool is final");
    assert!(w.settle(&a, id).await?.ok);
    assert_eq!(w.pool(id).await?["status"], "settled");
    w.check_invariants().await?;
    Ok(())
}

#[tokio::test]
async fn a_failed_payout_puts_the_pool_back_and_settle_can_be_retried() -> anyhow::Result<()> {
    let w = World::new().await?;
    let (id, seller, _a) = filled_pool(&w).await?;

    // the seller leaves the token, so the payout transfer fails
    w.unregister(&seller).await?;
    assert!(w.settle(&seller, id).await?.ok, "the call succeeds; its callback restores the pool");
    assert_eq!(w.pool(id).await?["status"], "filled");
    assert_eq!(w.balance(&w.pools).await?, 14 * MUSD, "nothing left the contract");
    w.check_invariants().await?;

    // the seller registers again and anyone retries
    w.register(&seller).await?;
    assert!(w.settle(&seller, id).await?.ok);
    assert_eq!(w.pool(id).await?["status"], "settled");
    assert_eq!(w.balance(&seller).await?, 14 * MUSD);
    w.check_invariants().await?;
    Ok(())
}
