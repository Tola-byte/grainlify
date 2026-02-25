// Tests for blacklist / whitelist functionality.
//
// These tests depend on contract methods (`set_blacklist`, `set_whitelist_mode`,
// `initialize`, and the `ParticipantNotAllowed` error variant) that have not
// been implemented yet.  They are gated behind `cfg(feature = "access_control")`
// so they compile-out until the feature lands (tracked in a future issue).

#![cfg(test)]
#![cfg(feature = "access_control")]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger, LedgerInfo, MockAuth, MockAuthInvoke},
    Address, Env, IntoVal, String,
};

fn create_env() -> Env {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set(LedgerInfo {
        timestamp: 1_000_000,
        protocol_version: 20,
        sequence_number: 100,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: 1_000,
        min_persistent_entry_ttl: 1_000,
        max_entry_ttl: 100_000,
    });
    env
}

fn setup(env: &Env) -> (BountyEscrowContractClient<'_>, Address, token::Client<'_>) {
    let admin = Address::generate(env);
    let depositor = Address::generate(env);

    let token_admin = Address::generate(env);
    let token_address = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let token_admin_client = token::StellarAssetClient::new(env, &token_address);
    let token_client = token::Client::new(env, &token_address);

    let contract_id = env.register_contract(None, BountyEscrowContract);
    let client = BountyEscrowContractClient::new(env, &contract_id);
    client.init(&admin, &token_address);

    token_admin_client.mint(&depositor, &10_000);
    (client, depositor, token_client)
}

#[test]
fn test_non_whitelisted_address_is_rate_limited_by_cooldown() {
    let env = create_env();
    let (client, depositor, _token) = setup(&env);

    client.update_anti_abuse_config(&3600, &100, &100);

    let deadline = env.ledger().timestamp() + 86_400;
    client.lock_funds(&depositor, &1, &100, &deadline);

    let second = client.try_lock_funds(&depositor, &2, &100, &deadline);
    assert!(second.is_err());
}

#[test]
fn test_whitelisted_address_bypasses_cooldown_check() {
    let env = create_env();
    let (client, depositor, token_client) = setup(&env);

    client.update_anti_abuse_config(&3600, &100, &100);
    client.set_whitelist(&depositor, &true);

    let deadline = env.ledger().timestamp() + 86_400;
    client.lock_funds(&depositor, &11, &100, &deadline);
    client.lock_funds(&depositor, &12, &100, &deadline);

    assert_eq!(token_client.balance(&client.address), 200);
}

#[test]
fn test_removed_from_whitelist_reenables_rate_limit_checks() {
    let env = create_env();
    let (client, depositor, _token) = setup(&env);

    client.update_anti_abuse_config(&3600, &100, &100);
    client.set_whitelist(&depositor, &true);
    client.set_whitelist(&depositor, &false);

<<<<<<< security/reentrancy-audit-and-guards
// ============================================================================
// Admin-Only Access Tests
// ============================================================================

/// Only the admin can modify the blacklist; other callers must be rejected.
#[test]
fn test_only_admin_can_set_blacklist() {
    let env = Env::default();
    env.ledger().set(LedgerInfo {
        timestamp: 1_000_000,
        protocol_version: 20,
        sequence_number: 100,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: 1000,
        min_persistent_entry_ttl: 1000,
        max_entry_ttl: 100_000,
    });
    env.mock_all_auths_allowing_non_root_auth();

    let admin = Address::generate(&env);
    let non_admin = Address::generate(&env);
    let token = Address::generate(&env);

    let contract_id = env.register_contract(None, BountyEscrowContract);
    let client = BountyEscrowContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token);

    let target = Address::generate(&env);

    // Admin call must succeed (auth is satisfied by mock).
    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "set_blacklist",
            args: (&target, &true, &None::<String>).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    client.set_blacklist(&target, &true, &None);

    // Non-admin call must panic / fail auth.
    env.mock_auths(&[MockAuth {
        address: &non_admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "set_blacklist",
            args: (&target, &false, &None::<String>).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    let result = client.try_set_blacklist(&target, &false, &None);
    assert!(result.is_err());
}

/// Only the admin can enable whitelist mode.
#[test]
fn test_only_admin_can_set_whitelist_mode() {
    let env = Env::default();
    env.ledger().set(LedgerInfo {
        timestamp: 1_000_000,
        protocol_version: 20,
        sequence_number: 100,
        network_id: Default::default(),
        base_reserve: 10,
        min_temp_entry_ttl: 1000,
        min_persistent_entry_ttl: 1000,
        max_entry_ttl: 100_000,
    });
    env.mock_all_auths_allowing_non_root_auth();

    let admin = Address::generate(&env);
    let non_admin = Address::generate(&env);
    let token = Address::generate(&env);

    let contract_id = env.register_contract(None, BountyEscrowContract);
    let client = BountyEscrowContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token);
=======
    let deadline = env.ledger().timestamp() + 86_400;
    client.lock_funds(&depositor, &21, &100, &deadline);
>>>>>>> master

    let second = client.try_lock_funds(&depositor, &22, &100, &deadline);
    assert!(second.is_err());
}
