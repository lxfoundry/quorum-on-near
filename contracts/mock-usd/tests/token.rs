use quorum_sandbox_support::{token_wasm, Chain};
use serde_json::json;

const STORAGE_DEPOSIT: u128 = 10_000_000_000_000_000_000_000; // 0.01 NEAR, the excess is refunded

#[tokio::test]
async fn metadata_names_the_token() -> anyhow::Result<()> {
    let chain = Chain::start().await?;
    let token = chain
        .deploy("musd", token_wasm()?, Some(("new", json!({}))))
        .await?;
    let md = chain.view(&token, "ft_metadata", json!({})).await?;
    assert_eq!(md["name"], "Mock USD");
    assert_eq!(md["symbol"], "mUSD");
    assert_eq!(md["decimals"], 6);
    Ok(())
}

#[tokio::test]
async fn mint_needs_registration_and_respects_the_cap() -> anyhow::Result<()> {
    let chain = Chain::start().await?;
    let token = chain
        .deploy("musd", token_wasm()?, Some(("new", json!({}))))
        .await?;
    let alice = chain.create_account("alice", 10).await?;
    let mint = |amount: &str| json!({ "account_id": alice, "amount": amount });

    // An unregistered account cannot be minted to.
    assert!(
        !chain
            .call(&alice, &token, "mint", mint("1000000"), 30, 0)
            .await?
            .ok
    );

    chain
        .call(
            &alice,
            &token,
            "storage_deposit",
            json!({ "account_id": alice, "registration_only": true }),
            30,
            STORAGE_DEPOSIT,
        )
        .await?;

    assert!(
        chain
            .call(&alice, &token, "mint", mint("1000000"), 30, 0)
            .await?
            .ok
    );
    let balance = chain
        .view(&token, "ft_balance_of", json!({ "account_id": alice }))
        .await?;
    assert_eq!(balance, "1000000");

    // 1,000 mUSD is the most one call can mint; one base unit more is refused.
    assert!(
        !chain
            .call(&alice, &token, "mint", mint("1000000001"), 30, 0)
            .await?
            .ok
    );
    assert!(
        chain
            .call(&alice, &token, "mint", mint("1000000000"), 30, 0)
            .await?
            .ok
    );
    assert!(
        !chain
            .call(&alice, &token, "mint", mint("0"), 30, 0)
            .await?
            .ok
    );
    Ok(())
}

#[tokio::test]
async fn registered_accounts_can_transfer() -> anyhow::Result<()> {
    let chain = Chain::start().await?;
    let token = chain
        .deploy("musd", token_wasm()?, Some(("new", json!({}))))
        .await?;
    let alice = chain.create_account("alice", 10).await?;
    let bob = chain.create_account("bob", 10).await?;
    for who in [&alice, &bob] {
        chain
            .call(
                who,
                &token,
                "storage_deposit",
                json!({ "account_id": who, "registration_only": true }),
                30,
                STORAGE_DEPOSIT,
            )
            .await?;
    }
    chain
        .call(
            &alice,
            &token,
            "mint",
            json!({ "account_id": alice, "amount": "5000000" }),
            30,
            0,
        )
        .await?;
    let sent = chain
        .call(
            &alice,
            &token,
            "ft_transfer",
            json!({ "receiver_id": bob, "amount": "2000000" }),
            30,
            1,
        )
        .await?;
    assert!(sent.ok);
    let bob_balance = chain
        .view(&token, "ft_balance_of", json!({ "account_id": bob }))
        .await?;
    assert_eq!(bob_balance, "2000000");
    Ok(())
}
