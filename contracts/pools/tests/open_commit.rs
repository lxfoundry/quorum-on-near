mod common;

use common::*;
use serde_json::json;

/// How block time behaves in the sandbox decides how the other scenarios wait for a deadline.
#[tokio::test]
async fn block_time_moves_forward_with_blocks() -> anyhow::Result<()> {
    let w = World::new().await?;
    let before = w.chain.now_ms().await?;
    w.chain.fast_forward(1000).await?;
    let after = w.chain.now_ms().await?;
    println!("block time moved {} ms over 1000 blocks", after - before);
    assert!(after > before, "block time did not advance");
    Ok(())
}

#[tokio::test]
async fn a_pool_fills_with_exact_commits() -> anyhow::Result<()> {
    let w = World::new().await?;
    let seller = w.user("seller", 10).await?;
    let (a, b, c) = (
        w.user("a", 10).await?,
        w.user("b", 10).await?,
        w.user("c", 10).await?,
    );
    let deadline = w.deadline_in(DEADLINE_MS).await?;

    let id = w
        .open(&seller, 10 * MUSD, 2 * MUSD, 4, deadline, None)
        .await?;
    w.check_invariants().await?;
    assert_eq!(
        w.balance(&seller).await?,
        0,
        "the whole balance went in as the bonus"
    );
    assert_eq!(w.pool(id).await?["status"], "open");

    assert!(w.commit(&a, id, 2, 2 * MUSD).await?.ok);
    w.check_invariants().await?;
    assert!(w.commit(&b, id, 1, 2 * MUSD).await?.ok);
    assert!(w.commit(&c, id, 1, 2 * MUSD).await?.ok);
    w.check_invariants().await?;

    let pool = w.pool(id).await?;
    assert_eq!(pool["status"], "filled");
    assert_eq!(pool["taken"], 4);
    assert_eq!(
        w.balance(&w.pools).await?,
        18 * MUSD,
        "8 mUSD of seats plus the 10 mUSD bonus"
    );
    assert_eq!(w.balance(&a).await?, 6 * MUSD);
    Ok(())
}

#[tokio::test]
async fn a_partial_last_commit_takes_the_seats_left_and_returns_the_rest() -> anyhow::Result<()> {
    let w = World::new().await?;
    let seller = w.user("seller", 10).await?;
    let (a, b) = (w.user("a", 10).await?, w.user("b", 10).await?);
    let deadline = w.deadline_in(DEADLINE_MS).await?;
    let id = w
        .open(&seller, 10 * MUSD, 2 * MUSD, 3, deadline, None)
        .await?;

    assert!(w.commit(&a, id, 2, 2 * MUSD).await?.ok);
    assert!(w.commit(&b, id, 2, 2 * MUSD).await?.ok); // asks for 2, only 1 is left
    w.check_invariants().await?;

    assert_eq!(w.pool(id).await?["status"], "filled");
    assert_eq!(w.balance(&b).await?, 8 * MUSD, "paid 4, got 2 back");
    let row = w
        .chain
        .view(
            &w.pools,
            "get_buyer",
            json!({ "pool_id": id, "account_id": b }),
        )
        .await?;
    assert_eq!(row["seats"], 1);
    Ok(())
}

#[tokio::test]
async fn refused_commits_return_the_money() -> anyhow::Result<()> {
    let w = World::new().await?;
    let seller = w.user("seller", 10).await?;
    let (a, b) = (w.user("a", 10).await?, w.user("b", 10).await?);
    let deadline = w.deadline_in(DEADLINE_MS).await?;
    let id = w
        .open(&seller, 10 * MUSD, 2 * MUSD, 8, deadline, Some(2))
        .await?;
    w.mint(&seller, 4).await?;

    // the wrong amount for the seats asked for
    let wrong = w
        .transfer_call(
            &b,
            3 * MUSD,
            json!({ "commit": { "pool_id": id, "seats": 2 } }),
        )
        .await?;
    assert!(wrong.ok, "the token call itself succeeds and refunds");
    assert_eq!(w.balance(&b).await?, 10 * MUSD);

    // the seller committing to its own pool
    w.commit(&seller, id, 1, 2 * MUSD).await?;
    assert_eq!(w.balance(&seller).await?, 4 * MUSD);

    // a commit past the per-buyer cap of 2
    assert!(w.commit(&a, id, 2, 2 * MUSD).await?.ok);
    w.commit(&a, id, 1, 2 * MUSD).await?;
    assert_eq!(w.balance(&a).await?, 6 * MUSD);

    let pool = w.pool(id).await?;
    assert_eq!(pool["taken"], 2, "only the one valid commit was taken");
    w.check_invariants().await?;
    Ok(())
}

#[tokio::test]
async fn a_payment_in_another_token_is_refused() -> anyhow::Result<()> {
    let w = World::new().await?;
    let fake = w
        .chain
        .deploy(
            "fake",
            quorum_sandbox_support::token_wasm()?,
            Some(("new", json!({}))),
        )
        .await?;
    let seller = w.chain.create_account("seller", 10).await?;
    let storage = 10_000_000_000_000_000_000_000u128;
    for who in [&seller, &w.pools] {
        w.chain
            .call(
                who,
                &fake,
                "storage_deposit",
                json!({ "account_id": who, "registration_only": true }),
                30,
                storage,
            )
            .await?;
    }
    w.chain
        .call(
            &seller,
            &fake,
            "mint",
            json!({ "account_id": seller, "amount": "10000000" }),
            30,
            0,
        )
        .await?;
    let deadline = w.deadline_in(DEADLINE_MS).await?;
    let msg = json!({ "open": {
        "seat_price": "2000000", "target": 4, "deadline_ms": deadline,
        "max_seats_per_buyer": null, "terms": "x",
    }});
    w.chain
        .call(
            &seller,
            &fake,
            "ft_transfer_call",
            json!({ "receiver_id": w.pools, "amount": "10000000", "msg": serde_json::to_string(&msg)? }),
            100,
            1,
        )
        .await?;

    assert_eq!(w.pool_count().await?, 0, "no pool was opened");
    let back = w
        .chain
        .view(&fake, "ft_balance_of", json!({ "account_id": seller }))
        .await?;
    assert_eq!(back, "10000000", "the other token was returned");
    Ok(())
}

#[tokio::test]
async fn a_commit_after_the_deadline_is_refused() -> anyhow::Result<()> {
    let w = World::new().await?;
    let seller = w.user("seller", 10).await?;
    let a = w.user("a", 10).await?;
    let deadline = w.deadline_in(DEADLINE_MS).await?;
    let id = w
        .open(&seller, 10 * MUSD, 2 * MUSD, 4, deadline, None)
        .await?;

    w.expire(id).await?;
    assert_eq!(
        w.pool(id).await?["status"],
        "expired",
        "the view reports expiry before any call stores it"
    );

    w.commit(&a, id, 1, 2 * MUSD).await?;
    assert_eq!(w.balance(&a).await?, 10 * MUSD, "the payment came back");
    assert_eq!(w.pool(id).await?["taken"], 0);
    w.check_invariants().await?;
    Ok(())
}

#[tokio::test]
async fn the_contract_cannot_be_initialised_again_or_by_another_account() -> anyhow::Result<()> {
    let w = World::new().await?;
    let stranger = w.chain.create_account("stranger", 10).await?;

    // another account cannot choose the token
    let by_stranger = w
        .chain
        .call(
            &stranger,
            &w.pools,
            "new",
            json!({ "token": stranger }),
            30,
            0,
        )
        .await?;
    assert!(!by_stranger.ok);

    // the contract account itself cannot run `new` a second time
    let again = w
        .chain
        .call(
            &w.pools,
            &w.pools,
            "new",
            json!({ "token": stranger }),
            30,
            0,
        )
        .await?;
    assert!(!again.ok);

    // the token is still the one set at deployment: a payment in it still opens a pool
    let seller = w.user("seller", 10).await?;
    let deadline = w.deadline_in(DEADLINE_MS).await?;
    w.open(&seller, 10 * MUSD, 2 * MUSD, 4, deadline, None)
        .await?;
    Ok(())
}
