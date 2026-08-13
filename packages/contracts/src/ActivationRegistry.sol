// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {Roles, EntitlementState} from "./RouteLockTypes.sol";
import {ServiceEntitlement} from "./ServiceEntitlement.sol";

/// @notice What the compliance engine concluded.
///
/// `NeedsInformation` and `Refused` are recorded, hashed, and committed exactly
/// as `Approved` is. They are correct outcomes, not errors — a system that only
/// commits its approvals to chain is publishing a biased record of itself.
enum Verdict {
    None,
    Approved,
    NeedsInformation,
    Refused
}

/// @title ActivationRegistry
/// @notice The audit anchor. Binds parcel data, the compliance decision, and the
///         carrier's own response to an entitlement — as hashes only.
///
/// No plaintext is stored here. Names, addresses, invoice contents and label
/// PDFs stay encrypted off-chain; what lands on chain is a commitment anyone can
/// verify against the document they were shown. `decisionHash` is the core of
/// that claim: the full decision JSON is served publicly, and anyone can
/// canonicalise it, hash it, and check it matches what this contract recorded.
contract ActivationRegistry is AccessControl {
    error NotTokenOwner(uint256 tokenId, address caller);
    error NotUnderReview(uint256 tokenId);
    error NotActivated(uint256 tokenId);
    error NoActivation(uint256 tokenId);
    error VerdictRequired();
    error ZeroAddress();
    error EmptyEngineVersion();

    event ParcelSubmitted(uint256 indexed tokenId, bytes32 parcelHash, bytes32 documentsHash, uint32 attempt);
    event DecisionRecorded(
        uint256 indexed tokenId, Verdict indexed verdict, bytes32 indexed decisionHash, string engineVersion
    );
    event CarrierRecorded(uint256 indexed tokenId, bytes32 carrierRefHash, bytes32 carrierRawHash);
    event TrackingPublished(uint256 indexed tokenId, string trackingNumber);

    struct Activation {
        bytes32 parcelHash; // hash(weight, dims, declaredValue, itemsCanonical)
        bytes32 documentsHash; // hash of the encrypted document bundle
        bytes32 decisionHash; // hash of the canonical compliance decision JSON
        bytes32 carrierRefHash; // hash(trackingNumber)
        bytes32 carrierRawHash; // hash of the raw carrier API response
        string engineVersion; // e.g. "compliance-1.2.0/hs-2026-rev3"
        uint64 submittedAt;
        uint64 activatedAt;
        uint32 attempt; // increments on each resubmission after a refusal
        Verdict verdict;
    }

    ServiceEntitlement public immutable entitlement;

    mapping(uint256 tokenId => Activation) public activations;

    /// @notice Tracking numbers, published only once delivery is complete and the
    ///         number is no longer sensitive. See `publishTracking`.
    mapping(uint256 tokenId => string) public trackingNumber;

    constructor(address admin, address entitlement_) {
        if (admin == address(0) || entitlement_ == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(Roles.ADMIN_ROLE, admin);
        entitlement = ServiceEntitlement(entitlement_);
    }

    // ---------------------------------------------------------------------
    // Submission
    // ---------------------------------------------------------------------

    /// @notice Bind parcel data to an entitlement and put it under review.
    ///         Only the current holder may do this.
    function submitParcel(uint256 tokenId, bytes32 parcelHash, bytes32 documentsHash) external {
        if (entitlement.ownerOf(tokenId) != msg.sender) revert NotTokenOwner(tokenId, msg.sender);

        Activation storage act = activations[tokenId];
        act.parcelHash = parcelHash;
        act.documentsHash = documentsHash;
        act.submittedAt = uint64(block.timestamp);
        act.attempt += 1;
        act.verdict = Verdict.None;
        // A resubmission supersedes the previous decision. The full history
        // survives in the event log, which is what the audit trail relies on.
        act.decisionHash = bytes32(0);

        entitlement.submitParcel(tokenId);

        emit ParcelSubmitted(tokenId, parcelHash, documentsHash, act.attempt);
    }

    // ---------------------------------------------------------------------
    // Compliance decision
    // ---------------------------------------------------------------------

    /// @notice Commit a compliance decision and open or close the activation gate.
    ///
    /// This is the *only* authority `COMPLIANCE_ROLE` has anywhere in the system.
    /// It moves no money — see `SettlementEscrow`, which refuses to grant this
    /// role at all.
    function recordDecision(
        uint256 tokenId,
        bytes32 decisionHash,
        string calldata engineVersion,
        Verdict verdict
    ) external onlyRole(Roles.COMPLIANCE_ROLE) {
        if (entitlement.stateOf(tokenId) != EntitlementState.PendingReview) {
            revert NotUnderReview(tokenId);
        }
        if (verdict == Verdict.None) revert VerdictRequired();
        if (bytes(engineVersion).length == 0) revert EmptyEngineVersion();

        Activation storage act = activations[tokenId];
        act.decisionHash = decisionHash;
        act.engineVersion = engineVersion;
        act.verdict = verdict;

        if (verdict == Verdict.Approved) {
            act.activatedAt = uint64(block.timestamp);
            entitlement.approveActivation(tokenId);
        } else {
            // Refused or needs information: the entitlement returns to
            // Available, fully reusable, and the buyer's funds never moved.
            entitlement.rejectActivation(tokenId);
        }

        emit DecisionRecorded(tokenId, verdict, decisionHash, engineVersion);
    }

    // ---------------------------------------------------------------------
    // Carrier evidence
    // ---------------------------------------------------------------------

    /// @notice Commit the carrier's own response alongside the state it caused.
    ///
    /// This is what answers the tracking-oracle objection. The chain does not
    /// simply take the backend's word that a label exists: it records a hash of
    /// the raw carrier payload, which is served publicly, so the claim becomes
    /// "here is the carrier's response, verify it yourself".
    function recordCarrier(uint256 tokenId, bytes32 carrierRefHash, bytes32 carrierRawHash)
        external
        onlyRole(Roles.ORACLE_ROLE)
    {
        EntitlementState state = entitlement.stateOf(tokenId);
        if (
            state != EntitlementState.Activated && state != EntitlementState.LabelCreated
                && state != EntitlementState.InTransit
        ) {
            revert NotActivated(tokenId);
        }

        Activation storage act = activations[tokenId];
        act.carrierRefHash = carrierRefHash;
        act.carrierRawHash = carrierRawHash;

        emit CarrierRecorded(tokenId, carrierRefHash, carrierRawHash);
    }

    /// @notice Reveal the tracking number once the parcel is delivered.
    ///
    /// Pre-delivery, a tracking number is sensitive — it exposes a live shipment
    /// to interference. Post-delivery it is merely evidence, and publishing the
    /// preimage lets anyone check it against `carrierRefHash` and against the
    /// courier's own public tracking page.
    function publishTracking(uint256 tokenId, string calldata trackingNumber_)
        external
        onlyRole(Roles.ORACLE_ROLE)
    {
        if (entitlement.stateOf(tokenId) != EntitlementState.Delivered) {
            revert NotActivated(tokenId);
        }
        if (activations[tokenId].submittedAt == 0) revert NoActivation(tokenId);

        trackingNumber[tokenId] = trackingNumber_;
        emit TrackingPublished(tokenId, trackingNumber_);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function verdictOf(uint256 tokenId) external view returns (Verdict) {
        return activations[tokenId].verdict;
    }

    function decisionHashOf(uint256 tokenId) external view returns (bytes32) {
        return activations[tokenId].decisionHash;
    }
}
