//! `Chain::create_account` must return an account the very next transaction can be signed for. The
//! sandbox applies a created account as a state patch that becomes final some blocks later, and the
//! signer reads a key's nonce at final finality, so an account that is not yet final makes the next
//! call fail with "access key does not exist".
//!
//! Without the wait in `create_account` this test fails only when the sandbox's node is slow to
//! finalise (a busy or small machine, for instance while the contracts are being built): on an idle
//! machine it passes either way. It checks the promise, and does not force the delay.

use quorum_sandbox_support::Chain;

const CHAINS: usize = 3;

#[tokio::test]
async fn a_created_account_can_be_signed_for_the_moment_it_is_returned() -> anyhow::Result<()> {
    // Start every chain first, as the contract tests do: each sits idle while the contracts build.
    let mut chains = Vec::new();
    for _ in 0..CHAINS {
        chains.push(Chain::start().await?);
    }
    for chain in &chains {
        let key = chain.signer.get_public_key().await?;
        let id = chain.create_account("first", 1).await?;
        chain
            .signer
            .fetch_tx_nonce(id.clone(), key, &chain.network)
            .await
            .map_err(|error| anyhow::anyhow!("{id} right after creating it: {error}"))?;
    }
    Ok(())
}
