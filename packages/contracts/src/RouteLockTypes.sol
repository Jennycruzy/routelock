// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Lifecycle of a single entitlement token.
///
/// `None` is the zero value and means "never minted". Every other state is
/// reachable only through an explicit, role-guarded transition on
/// `ServiceEntitlement`.
///
/// There is deliberately no `Transferred` state. A transfer changes `ownerOf`,
/// not what the token *is*, so representing it as a state would add a row to
/// every transition table for no gain.
enum EntitlementState {
    None,
    Available,
    PendingReview,
    Activated,
    LabelCreated,
    InTransit,
    Delivered,
    Remedied,
    Expired
}

/// @notice A class of service commitments issued by one issuer.
///
/// This is deliberately *not* delivery-specific. The service being promised is
/// described by `termsHash` — the hash of the signed terms document — and by
/// the class identifier. Delivery lives in an off-chain adapter, which is what
/// lets the same contracts back warehousing, cold chain, or equipment time
/// without a redeploy.
struct ServiceSpec {
    bytes32 classId; // keccak256 of a human label, e.g. "PHC-LOS-1KG-STD"
    address issuer;
    bytes32 termsHash; // hash of the signed/acknowledged terms document
    address settlementToken;
    uint256 pricePerUnit; // what a buyer pays to mint one entitlement
    uint256 payoutObligation; // what the issuer owes per unit if they fail to honour it
    uint64 validUntil;
    uint32 maxSupply;
    uint32 minted;
    bool paused;
}

/// @notice Role identifiers, shared so that every contract agrees on them.
///
/// The separation that matters most: `COMPLIANCE_ROLE` appears nowhere in
/// `SettlementEscrow`. The compliance engine can open the activation gate and it
/// can commit a decision hash, but it cannot move a single token of value. The
/// AI approving an activation and money being released are two distinct events
/// with two distinct triggers, and that is enforced structurally rather than by
/// convention.
library Roles {
    /// @dev Issues classes and claims settlement once fulfilment is proven.
    bytes32 internal constant ISSUER_ROLE = keccak256("ISSUER_ROLE");

    /// @dev Backend signer. Writes carrier-sourced state: label, pickup, delivery.
    bytes32 internal constant ORACLE_ROLE = keccak256("ORACLE_ROLE");

    /// @dev The compliance service. Records decision hashes and approves or
    ///      rejects activation. Has no authority over funds anywhere.
    bytes32 internal constant COMPLIANCE_ROLE = keccak256("COMPLIANCE_ROLE");

    /// @dev Registers issuers, pauses them, wires contracts together.
    bytes32 internal constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    /// @dev Held by `EntitlementFactory` so it alone can mint and record deposits.
    bytes32 internal constant FACTORY_ROLE = keccak256("FACTORY_ROLE");

    /// @dev Held by `ActivationRegistry` so it alone can drive the review
    ///      transitions on `ServiceEntitlement`.
    bytes32 internal constant REGISTRY_ROLE = keccak256("REGISTRY_ROLE");
}

/// @notice The subset of class data other contracts need to read.
interface IEntitlementClasses {
    function classIssuer(bytes32 classId) external view returns (address);
    function classValidUntil(bytes32 classId) external view returns (uint64);
    function classExists(bytes32 classId) external view returns (bool);
}
