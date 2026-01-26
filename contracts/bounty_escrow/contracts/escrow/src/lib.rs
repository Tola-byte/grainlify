#![no_std]
mod events;
mod test_bounty_escrow;

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, token, Address, Env, Vec};
use events::{BountyEscrowInitialized, FundsLocked, FundsReleased, FundsRefunded, BatchFundsLocked, BatchFundsReleased, emit_bounty_initialized, emit_funds_locked, emit_funds_released, emit_funds_refunded, emit_batch_funds_locked, emit_batch_funds_released};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    BountyExists = 3,
    BountyNotFound = 4,
    FundsNotLocked = 5,
    DeadlineNotPassed = 6,
    Unauthorized = 7,
    InvalidBatchSize = 8,
    BatchSizeMismatch = 9,
    DuplicateBountyId = 10,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EscrowStatus {
    Locked,
    Released,
    Refunded,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Escrow {
    pub depositor: Address,
    pub amount: i128,
    pub status: EscrowStatus,
    pub deadline: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LockFundsItem {
    pub bounty_id: u64,
    pub depositor: Address,
    pub amount: i128,
    pub deadline: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReleaseFundsItem {
    pub bounty_id: u64,
    pub contributor: Address,
}

// Maximum batch size to prevent gas limit issues
const MAX_BATCH_SIZE: u32 = 100;

#[contracttype]
pub enum DataKey {
    Admin,
    Token,
    Escrow(u64), // bounty_id
}

#[contract]
pub struct BountyEscrowContract;

#[contractimpl]
impl BountyEscrowContract {
    /// Initialize the contract with the admin address and the token address (XLM).
    pub fn init(env: Env, admin: Address, token: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token, &token);

        emit_bounty_initialized(
            &env,
            BountyEscrowInitialized {
                admin,
                token,
                timestamp: env.ledger().timestamp()
            },
        );

        Ok(())
    }

    /// Lock funds for a specific bounty.
    pub fn lock_funds(
        env: Env,
        depositor: Address,
        bounty_id: u64,
        amount: i128,
        deadline: u64,
    ) -> Result<(), Error> {
        depositor.require_auth();

        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::NotInitialized);
        }

        if env.storage().persistent().has(&DataKey::Escrow(bounty_id)) {
            return Err(Error::BountyExists);
        }

        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let client = token::Client::new(&env, &token_addr);

        // Transfer funds from depositor to contract
        client.transfer(&depositor, &env.current_contract_address(), &amount);

        let escrow = Escrow {
            depositor: depositor.clone(),
            amount,
            status: EscrowStatus::Locked,
            deadline,
        };

        // Extend the TTL of the storage entry to ensure it lives long enough
        env.storage().persistent().set(&DataKey::Escrow(bounty_id), &escrow);
        
        // Emit value allows for off-chain indexing
        emit_funds_locked(
            &env,
            FundsLocked {
                bounty_id,
                amount,
                depositor: depositor.clone(),
                deadline
            },
        );

        Ok(())
    }

    /// Release funds to the contributor.
    /// Only the admin (backend) can authorize this.
    pub fn release_funds(env: Env, bounty_id: u64, contributor: Address) -> Result<(), Error> {
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::NotInitialized);
        }

        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();

        if !env.storage().persistent().has(&DataKey::Escrow(bounty_id)) {
            return Err(Error::BountyNotFound);
        }

        let mut escrow: Escrow = env.storage().persistent().get(&DataKey::Escrow(bounty_id)).unwrap();

        if escrow.status != EscrowStatus::Locked {
            return Err(Error::FundsNotLocked);
        }

        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let client = token::Client::new(&env, &token_addr);

        // Transfer funds to contributor
        client.transfer(&env.current_contract_address(), &contributor, &escrow.amount);

        escrow.status = EscrowStatus::Released;
        env.storage().persistent().set(&DataKey::Escrow(bounty_id), &escrow);

        emit_funds_released(
            &env,
            FundsReleased {
                bounty_id,
                amount: escrow.amount,
                recipient: contributor.clone(),
                timestamp: env.ledger().timestamp()
            },
        );


        Ok(())
    }

    /// Refund funds to the original depositor if the deadline has passed.
    pub fn refund(env: Env, bounty_id: u64) -> Result<(), Error> {
        // We'll allow anyone to trigger the refund if conditions are met, 
        // effectively making it permissionless but conditional.
        // OR we can require depositor auth. Let's make it permissionless to ensure funds aren't stuck if depositor key is lost,
        // but strictly logic bound.
        // However, usually refund is triggered by depositor. Let's stick to logic.
        
        if !env.storage().persistent().has(&DataKey::Escrow(bounty_id)) {
            return Err(Error::BountyNotFound);
        }

        let mut escrow: Escrow = env.storage().persistent().get(&DataKey::Escrow(bounty_id)).unwrap();

        if escrow.status != EscrowStatus::Locked {
            return Err(Error::FundsNotLocked);
        }

        let now = env.ledger().timestamp();
        if now < escrow.deadline {
            return Err(Error::DeadlineNotPassed);
        }

        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let client = token::Client::new(&env, &token_addr);

        // Transfer funds back to depositor
        client.transfer(&env.current_contract_address(), &escrow.depositor, &escrow.amount);

        escrow.status = EscrowStatus::Refunded;
        env.storage().persistent().set(&DataKey::Escrow(bounty_id), &escrow);

        emit_funds_refunded(
            &env,
            FundsRefunded {
                bounty_id,
                amount: escrow.amount,
                refund_to: escrow.depositor,
                timestamp: env.ledger().timestamp()
            },
        );

        Ok(())
    }

    /// view function to get escrow info
    pub fn get_escrow_info(env: Env, bounty_id: u64) -> Result<Escrow, Error> {
         if !env.storage().persistent().has(&DataKey::Escrow(bounty_id)) {
            return Err(Error::BountyNotFound);
        }
        Ok(env.storage().persistent().get(&DataKey::Escrow(bounty_id)).unwrap())
    }

    /// view function to get contract balance of the token
    pub fn get_balance(env: Env) -> Result<i128, Error> {
         if !env.storage().instance().has(&DataKey::Token) {
            return Err(Error::NotInitialized);
        }
        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let client = token::Client::new(&env, &token_addr);
        Ok(client.balance(&env.current_contract_address()))
    }

    /// Batch lock funds for multiple bounties in a single transaction.
    /// This improves gas efficiency by reducing transaction overhead.
    /// 
    /// # Arguments
    /// * `items` - Vector of LockFundsItem containing bounty_id, depositor, amount, and deadline
    /// 
    /// # Returns
    /// Number of successfully locked bounties
    /// 
    /// # Errors
    /// * InvalidBatchSize - if batch size exceeds MAX_BATCH_SIZE or is zero
    /// * BountyExists - if any bounty_id already exists
    /// * NotInitialized - if contract is not initialized
    /// 
    /// # Note
    /// This operation is atomic - if any item fails, the entire transaction reverts.
    pub fn batch_lock_funds(env: Env, items: Vec<LockFundsItem>) -> Result<u32, Error> {
        // Validate batch size
        let batch_size = items.len() as u32;
        if batch_size == 0 {
            return Err(Error::InvalidBatchSize);
        }
        if batch_size > MAX_BATCH_SIZE {
            return Err(Error::InvalidBatchSize);
        }

        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::NotInitialized);
        }

        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let client = token::Client::new(&env, &token_addr);
        let contract_address = env.current_contract_address();
        let timestamp = env.ledger().timestamp();

        // Validate all items before processing (all-or-nothing approach)
        for item in items.iter() {
            // Check if bounty already exists
            if env.storage().persistent().has(&DataKey::Escrow(item.bounty_id)) {
                return Err(Error::BountyExists);
            }

            // Validate amount
            if item.amount <= 0 {
                return Err(Error::InvalidBatchSize);
            }

            // Check for duplicate bounty_ids in the batch
            let mut count = 0u32;
            for other_item in items.iter() {
                if other_item.bounty_id == item.bounty_id {
                    count += 1;
                }
            }
            if count > 1 {
                return Err(Error::DuplicateBountyId);
            }
        }

        // Collect unique depositors and require auth once for each
        // This prevents "frame is already authorized" errors when same depositor appears multiple times
        let mut seen_depositors: Vec<Address> = Vec::new(&env);
        for item in items.iter() {
            let mut found = false;
            for seen in seen_depositors.iter() {
                if seen.clone() == item.depositor {
                    found = true;
                    break;
                }
            }
            if !found {
                seen_depositors.push_back(item.depositor.clone());
                item.depositor.require_auth();
            }
        }

        // Process all items (atomic - all succeed or all fail)
        let mut locked_count = 0u32;
        for item in items.iter() {
            // Transfer funds from depositor to contract
            client.transfer(&item.depositor, &contract_address, &item.amount);

            // Create escrow record
            let escrow = Escrow {
                depositor: item.depositor.clone(),
                amount: item.amount,
                status: EscrowStatus::Locked,
                deadline: item.deadline,
            };

            // Store escrow
            env.storage().persistent().set(&DataKey::Escrow(item.bounty_id), &escrow);

            // Emit individual event for each locked bounty
            emit_funds_locked(
                &env,
                FundsLocked {
                    bounty_id: item.bounty_id,
                    amount: item.amount,
                    depositor: item.depositor.clone(),
                    deadline: item.deadline,
                },
            );

            locked_count += 1;
        }

        // Emit batch event
        emit_batch_funds_locked(
            &env,
            BatchFundsLocked {
                count: locked_count,
                total_amount: items.iter().map(|i| i.amount).sum(),
                timestamp,
            },
        );

        Ok(locked_count)
    }

    /// Batch release funds to multiple contributors in a single transaction.
    /// This improves gas efficiency by reducing transaction overhead.
    /// 
    /// # Arguments
    /// * `items` - Vector of ReleaseFundsItem containing bounty_id and contributor address
    /// 
    /// # Returns
    /// Number of successfully released bounties
    /// 
    /// # Errors
    /// * InvalidBatchSize - if batch size exceeds MAX_BATCH_SIZE or is zero
    /// * BountyNotFound - if any bounty_id doesn't exist
    /// * FundsNotLocked - if any bounty is not in Locked status
    /// * Unauthorized - if caller is not admin
    /// 
    /// # Note
    /// This operation is atomic - if any item fails, the entire transaction reverts.
    pub fn batch_release_funds(env: Env, items: Vec<ReleaseFundsItem>) -> Result<u32, Error> {
        // Validate batch size
        let batch_size = items.len() as u32;
        if batch_size == 0 {
            return Err(Error::InvalidBatchSize);
        }
        if batch_size > MAX_BATCH_SIZE {
            return Err(Error::InvalidBatchSize);
        }

        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::NotInitialized);
        }

        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();

        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let client = token::Client::new(&env, &token_addr);
        let contract_address = env.current_contract_address();
        let timestamp = env.ledger().timestamp();

        // Validate all items before processing (all-or-nothing approach)
        let mut total_amount: i128 = 0;
        for item in items.iter() {
            // Check if bounty exists
            if !env.storage().persistent().has(&DataKey::Escrow(item.bounty_id)) {
                return Err(Error::BountyNotFound);
            }

            let escrow: Escrow = env.storage()
                .persistent()
                .get(&DataKey::Escrow(item.bounty_id))
                .unwrap();

            // Check if funds are locked
            if escrow.status != EscrowStatus::Locked {
                return Err(Error::FundsNotLocked);
            }

            // Check for duplicate bounty_ids in the batch
            let mut count = 0u32;
            for other_item in items.iter() {
                if other_item.bounty_id == item.bounty_id {
                    count += 1;
                }
            }
            if count > 1 {
                return Err(Error::DuplicateBountyId);
            }

            total_amount = total_amount
                .checked_add(escrow.amount)
                .ok_or(Error::InvalidBatchSize)?;
        }

        // Process all items (atomic - all succeed or all fail)
        let mut released_count = 0u32;
        for item in items.iter() {
            let mut escrow: Escrow = env.storage()
                .persistent()
                .get(&DataKey::Escrow(item.bounty_id))
                .unwrap();

            // Transfer funds to contributor
            client.transfer(&contract_address, &item.contributor, &escrow.amount);

            // Update escrow status
            escrow.status = EscrowStatus::Released;
            env.storage().persistent().set(&DataKey::Escrow(item.bounty_id), &escrow);

            // Emit individual event for each released bounty
            emit_funds_released(
                &env,
                FundsReleased {
                    bounty_id: item.bounty_id,
                    amount: escrow.amount,
                    recipient: item.contributor.clone(),
                    timestamp,
                },
            );

            released_count += 1;
        }

        // Emit batch event
        emit_batch_funds_released(
            &env,
            BatchFundsReleased {
                count: released_count,
                total_amount,
                timestamp,
            },
        );

        Ok(released_count)
    }
}

#[cfg(test)]
mod test;
