use soroban_sdk::{contracterror, xdr::ScAddress, Address, Env};

pub type AssetId = Address;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum AssetIdError {
    MustBeContractAddress = 200,
}

/// Normalizes an incoming asset identifier to the canonical `AssetId`.
/// Current normalization is identity after validation.
pub fn normalize_asset_id(env: &Env, raw_asset_id: &Address) -> Result<AssetId, AssetIdError> {
    validate_asset_id(env, raw_asset_id)?;
    Ok(raw_asset_id.clone())
}

/// Validates the canonical asset identifier invariants.
/// For token operations, asset ids must be Soroban contract addresses.
pub fn validate_asset_id(env: &Env, asset_id: &AssetId) -> Result<(), AssetIdError> {
    let _ = env;
    let sc_address = ScAddress::from(asset_id);

    match sc_address {
        ScAddress::Contract(_) => Ok(()),
        _ => Err(AssetIdError::MustBeContractAddress),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    #[test]
    fn accepts_contract_address_asset_id() {
        let env = Env::default();
        let contract_address = Address::generate(&env);
        assert_eq!(validate_asset_id(&env, &contract_address), Ok(()));
    }

    #[test]
    fn rejects_account_address_asset_id() {
        let env = Env::default();
        let issuer_admin = Address::generate(&env);
        let stellar_asset = env.register_stellar_asset_contract_v2(issuer_admin);
        let account_address = stellar_asset.issuer().address();

        assert_eq!(
            validate_asset_id(&env, &account_address),
            Err(AssetIdError::MustBeContractAddress)
        );
    }
}
