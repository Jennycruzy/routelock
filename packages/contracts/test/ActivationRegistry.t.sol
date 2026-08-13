// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {RouteLockBase} from "./RouteLockBase.t.sol";
import {ActivationRegistry, Verdict} from "../src/ActivationRegistry.sol";
import {ServiceEntitlement} from "../src/ServiceEntitlement.sol";
import {EntitlementState, Roles} from "../src/RouteLockTypes.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

/// @notice The audit anchor, tested as the place where refusal is recorded.
///
/// The emphasis is deliberate: `NeedsInformation` and `Refused` get the same
/// coverage as `Approved`, because a decision record that only proves approvals
/// happened is not an audit trail. Where a case has an approve/refuse pair, both
/// halves are written out rather than parameterised, so a regression names the
/// verdict it broke.
contract ActivationRegistryTest is RouteLockBase {
    bytes32 internal constant PARCEL_HASH = keccak256("parcel");
    bytes32 internal constant DOCS_HASH = keccak256("docs");
    bytes32 internal constant DECISION_HASH = keccak256("decision");
    string internal constant ENGINE = "compliance-1.0.0/hs-2026";

    event ParcelSubmitted(uint256 indexed tokenId, bytes32 parcelHash, bytes32 documentsHash, uint32 attempt);
    event DecisionRecorded(
        uint256 indexed tokenId, Verdict indexed verdict, bytes32 indexed decisionHash, string engineVersion
    );
    event CarrierRecorded(uint256 indexed tokenId, bytes32 carrierRefHash, bytes32 carrierRawHash);
    event TrackingPublished(uint256 indexed tokenId, string trackingNumber);

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    function test_constructorRejectsZeroAdmin() public {
        vm.expectRevert(ActivationRegistry.ZeroAddress.selector);
        new ActivationRegistry(address(0), address(entitlement));
    }

    function test_constructorRejectsZeroEntitlement() public {
        vm.expectRevert(ActivationRegistry.ZeroAddress.selector);
        new ActivationRegistry(admin, address(0));
    }

    // ---------------------------------------------------------------------
    // Submission — holder only
    // ---------------------------------------------------------------------

    function test_submitParcelBindsHashesAndMovesToReview() public {
        uint256 tokenId = _classWithOneEntitlement();

        vm.expectEmit(true, false, false, true, address(registry));
        emit ParcelSubmitted(tokenId, PARCEL_HASH, DOCS_HASH, 1);

        vm.prank(buyer);
        registry.submitParcel(tokenId, PARCEL_HASH, DOCS_HASH);

        _assertState(tokenId, EntitlementState.PendingReview);

        (bytes32 parcelHash, bytes32 documentsHash,,,,, uint64 submittedAt,, uint32 attempt, Verdict verdict) =
            registry.activations(tokenId);
        assertEq(parcelHash, PARCEL_HASH);
        assertEq(documentsHash, DOCS_HASH);
        assertEq(submittedAt, uint64(block.timestamp));
        assertEq(attempt, 1);
        assertEq(uint8(verdict), uint8(Verdict.None), "verdict set before any decision");
    }

    function test_onlyTokenOwnerMaySubmitParcel() public {
        uint256 tokenId = _classWithOneEntitlement();

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(ActivationRegistry.NotTokenOwner.selector, tokenId, stranger)
        );
        registry.submitParcel(tokenId, PARCEL_HASH, DOCS_HASH);

        _assertState(tokenId, EntitlementState.Available);
    }

    /// @notice Not even the issuer who sold the entitlement may submit for it.
    ///
    /// The holder is the counterparty whose parcel this is; the issuer selling
    /// the class does not entitle them to bind data to a token they no longer own.
    function test_issuerMayNotSubmitForABuyersToken() public {
        uint256 tokenId = _classWithOneEntitlement();

        vm.prank(issuer);
        vm.expectRevert(
            abi.encodeWithSelector(ActivationRegistry.NotTokenOwner.selector, tokenId, issuer)
        );
        registry.submitParcel(tokenId, PARCEL_HASH, DOCS_HASH);
    }

    /// @notice The right to submit follows the token, and only the token.
    function test_submissionRightTransfersWithTheToken() public {
        uint256 tokenId = _classWithOneEntitlement();

        vm.prank(buyer);
        entitlement.transferFrom(buyer, stranger, tokenId);

        // The previous holder loses the right at the same instant.
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(ActivationRegistry.NotTokenOwner.selector, tokenId, buyer)
        );
        registry.submitParcel(tokenId, PARCEL_HASH, DOCS_HASH);

        vm.prank(stranger);
        registry.submitParcel(tokenId, PARCEL_HASH, DOCS_HASH);
        _assertState(tokenId, EntitlementState.PendingReview);
    }

    function test_submitParcelOnUnmintedTokenReverts() public {
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 999));
        registry.submitParcel(999, PARCEL_HASH, DOCS_HASH);
    }

    /// @notice Two submissions without an intervening decision is not a path.
    function test_cannotResubmitWhileUnderReview() public {
        uint256 tokenId = _classWithOneEntitlement();
        _submit(tokenId, buyer);

        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                ServiceEntitlement.InvalidTransition.selector,
                tokenId,
                EntitlementState.PendingReview,
                EntitlementState.PendingReview
            )
        );
        registry.submitParcel(tokenId, PARCEL_HASH, DOCS_HASH);
    }

    // ---------------------------------------------------------------------
    // Decisions — compliance only
    // ---------------------------------------------------------------------

    function test_onlyComplianceRoleMayRecordDecision() public {
        uint256 tokenId = _classWithOneEntitlement();
        _submit(tokenId, buyer);

        address[3] memory outsiders = [stranger, oracle, admin];
        for (uint256 i = 0; i < outsiders.length; i++) {
            vm.prank(outsiders[i]);
            vm.expectRevert(
                abi.encodeWithSelector(
                    IAccessControl.AccessControlUnauthorizedAccount.selector,
                    outsiders[i],
                    Roles.COMPLIANCE_ROLE
                )
            );
            registry.recordDecision(tokenId, DECISION_HASH, ENGINE, Verdict.Approved);
        }

        _assertState(tokenId, EntitlementState.PendingReview);
    }

    /// @notice The token holder cannot approve their own parcel.
    function test_holderCannotDecideOnTheirOwnParcel() public {
        uint256 tokenId = _classWithOneEntitlement();
        _submit(tokenId, buyer);

        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, buyer, Roles.COMPLIANCE_ROLE
            )
        );
        registry.recordDecision(tokenId, DECISION_HASH, ENGINE, Verdict.Approved);
    }

    function test_verdictNoneReverts() public {
        uint256 tokenId = _classWithOneEntitlement();
        _submit(tokenId, buyer);

        vm.prank(compliance);
        vm.expectRevert(ActivationRegistry.VerdictRequired.selector);
        registry.recordDecision(tokenId, DECISION_HASH, ENGINE, Verdict.None);

        _assertState(tokenId, EntitlementState.PendingReview);
    }

    /// @notice A decision that cannot name the engine that produced it is not a
    ///         reproducible decision, so it is not recordable.
    function test_emptyEngineVersionReverts() public {
        uint256 tokenId = _classWithOneEntitlement();
        _submit(tokenId, buyer);

        vm.prank(compliance);
        vm.expectRevert(ActivationRegistry.EmptyEngineVersion.selector);
        registry.recordDecision(tokenId, DECISION_HASH, "", Verdict.Approved);

        _assertState(tokenId, EntitlementState.PendingReview);
    }

    function test_emptyEngineVersionRevertsOnRefusalToo() public {
        uint256 tokenId = _classWithOneEntitlement();
        _submit(tokenId, buyer);

        vm.prank(compliance);
        vm.expectRevert(ActivationRegistry.EmptyEngineVersion.selector);
        registry.recordDecision(tokenId, DECISION_HASH, "", Verdict.Refused);
    }

    function test_decisionOnUnsubmittedTokenReverts() public {
        uint256 tokenId = _classWithOneEntitlement();

        vm.prank(compliance);
        vm.expectRevert(abi.encodeWithSelector(ActivationRegistry.NotUnderReview.selector, tokenId));
        registry.recordDecision(tokenId, DECISION_HASH, ENGINE, Verdict.Approved);
    }

    function test_secondDecisionOnAnApprovedTokenReverts() public {
        uint256 tokenId = _classWithOneEntitlement();
        _submit(tokenId, buyer);
        _decide(tokenId, Verdict.Approved);

        vm.prank(compliance);
        vm.expectRevert(abi.encodeWithSelector(ActivationRegistry.NotUnderReview.selector, tokenId));
        registry.recordDecision(tokenId, keccak256("second"), ENGINE, Verdict.Refused);
    }

    /// @notice Compliance cannot revisit a shipment the carrier already has.
    function test_decisionOnAnInFlightTokenReverts() public {
        uint256 tokenId = _classWithOneEntitlement();
        _submit(tokenId, buyer);
        _decide(tokenId, Verdict.Approved);
        vm.prank(oracle);
        entitlement.recordLabel(tokenId);

        vm.prank(compliance);
        vm.expectRevert(abi.encodeWithSelector(ActivationRegistry.NotUnderReview.selector, tokenId));
        registry.recordDecision(tokenId, DECISION_HASH, ENGINE, Verdict.Refused);
    }

    function test_decisionOnUnmintedTokenReverts() public {
        vm.prank(compliance);
        vm.expectRevert(abi.encodeWithSelector(ActivationRegistry.NotUnderReview.selector, 999));
        registry.recordDecision(999, DECISION_HASH, ENGINE, Verdict.Approved);
    }

    // ---------------------------------------------------------------------
    // Approval
    // ---------------------------------------------------------------------

    function test_approvalActivatesAndStampsTime() public {
        uint256 tokenId = _classWithOneEntitlement();
        _submit(tokenId, buyer);

        vm.expectEmit(true, true, true, true, address(registry));
        emit DecisionRecorded(tokenId, Verdict.Approved, DECISION_HASH, ENGINE);
        _decide(tokenId, Verdict.Approved);

        _assertState(tokenId, EntitlementState.Activated);

        (,, bytes32 decisionHash,,, string memory engineVersion,, uint64 activatedAt,, Verdict verdict) =
            registry.activations(tokenId);
        assertEq(decisionHash, DECISION_HASH);
        assertEq(engineVersion, ENGINE);
        assertEq(activatedAt, uint64(block.timestamp));
        assertEq(uint8(verdict), uint8(Verdict.Approved));
        assertEq(uint8(registry.verdictOf(tokenId)), uint8(Verdict.Approved));
        assertEq(registry.decisionHashOf(tokenId), DECISION_HASH);
    }

    // ---------------------------------------------------------------------
    // Refusal is a success path
    // ---------------------------------------------------------------------

    /// @notice A refusal is committed on chain exactly as an approval is.
    ///
    /// This is the assertion that stops the on-chain record becoming a
    /// highlight reel of the cases the engine happened to get confident about.
    function test_refusalStoresItsDecisionHash() public {
        uint256 tokenId = _classWithOneEntitlement();
        _submit(tokenId, buyer);

        vm.expectEmit(true, true, true, true, address(registry));
        emit DecisionRecorded(tokenId, Verdict.Refused, DECISION_HASH, ENGINE);
        _decide(tokenId, Verdict.Refused);

        (,, bytes32 decisionHash,,, string memory engineVersion,, uint64 activatedAt,, Verdict verdict) =
            registry.activations(tokenId);
        assertEq(decisionHash, DECISION_HASH, "refusal left no commitment");
        assertEq(engineVersion, ENGINE, "refusal recorded without its engine version");
        assertEq(uint8(verdict), uint8(Verdict.Refused));
        assertEq(activatedAt, 0, "refusal stamped an activation time");
    }

    function test_needsInformationStoresItsDecisionHash() public {
        uint256 tokenId = _classWithOneEntitlement();
        _submit(tokenId, buyer);

        vm.expectEmit(true, true, true, true, address(registry));
        emit DecisionRecorded(tokenId, Verdict.NeedsInformation, DECISION_HASH, ENGINE);
        _decide(tokenId, Verdict.NeedsInformation);

        assertEq(registry.decisionHashOf(tokenId), DECISION_HASH);
        assertEq(uint8(registry.verdictOf(tokenId)), uint8(Verdict.NeedsInformation));
    }

    /// @notice Refusal costs the holder nothing but time: the entitlement is
    ///         returned intact and remains as usable as before it was submitted.
    function test_refusalReturnsTheEntitlementUnharmed() public {
        uint256 tokenId = _classWithOneEntitlement();
        uint256 escrowBefore = token.balanceOf(address(escrow));

        _submit(tokenId, buyer);
        _decide(tokenId, Verdict.Refused);

        _assertState(tokenId, EntitlementState.Available);
        assertEq(entitlement.ownerOf(tokenId), buyer, "refusal moved the token");
        assertEq(token.balanceOf(address(escrow)), escrowBefore, "refusal moved money");

        // Still transferable, because it is Available again.
        vm.prank(buyer);
        entitlement.transferFrom(buyer, stranger, tokenId);
        assertEq(entitlement.ownerOf(tokenId), stranger);
    }

    function test_needsInformationReturnsTheEntitlementUnharmed() public {
        uint256 tokenId = _classWithOneEntitlement();

        _submit(tokenId, buyer);
        _decide(tokenId, Verdict.NeedsInformation);

        _assertState(tokenId, EntitlementState.Available);
        assertEq(entitlement.ownerOf(tokenId), buyer);
    }

    // ---------------------------------------------------------------------
    // Resubmission after refusal
    // ---------------------------------------------------------------------

    /// @notice The retry loop: refuse, correct the parcel, submit again.
    ///
    /// The stale decision hash must be cleared. Leaving it would let a caller
    /// read a superseded refusal as if it described the parcel now under review.
    function test_resubmissionIncrementsAttemptAndClearsStaleDecision() public {
        uint256 tokenId = _classWithOneEntitlement();
        _submit(tokenId, buyer);
        _decide(tokenId, Verdict.Refused);
        assertEq(registry.decisionHashOf(tokenId), DECISION_HASH);

        bytes32 correctedParcel = keccak256("parcel-with-hs-code");
        vm.expectEmit(true, false, false, true, address(registry));
        emit ParcelSubmitted(tokenId, correctedParcel, DOCS_HASH, 2);

        vm.prank(buyer);
        registry.submitParcel(tokenId, correctedParcel, DOCS_HASH);

        (bytes32 parcelHash,, bytes32 decisionHash,,,,,, uint32 attempt, Verdict verdict) =
            registry.activations(tokenId);
        assertEq(attempt, 2, "attempt did not increment");
        assertEq(decisionHash, bytes32(0), "stale decision hash survived resubmission");
        assertEq(uint8(verdict), uint8(Verdict.None), "stale verdict survived resubmission");
        assertEq(parcelHash, correctedParcel, "parcel hash not superseded");
    }

    /// @notice Refused, corrected, approved — the whole loop, ending in activation.
    function test_refusalThenCorrectionThenApproval() public {
        uint256 tokenId = _classWithOneEntitlement();
        _submit(tokenId, buyer);
        _decide(tokenId, Verdict.NeedsInformation);

        vm.prank(buyer);
        registry.submitParcel(tokenId, keccak256("parcel-v2"), keccak256("docs-v2"));

        vm.prank(compliance);
        registry.recordDecision(tokenId, keccak256("decision-v2"), ENGINE, Verdict.Approved);

        _assertState(tokenId, EntitlementState.Activated);
        assertEq(registry.decisionHashOf(tokenId), keccak256("decision-v2"));

        (,,,,,,, uint64 activatedAt, uint32 attempt,) = registry.activations(tokenId);
        assertEq(attempt, 2);
        assertEq(activatedAt, uint64(block.timestamp));
    }

    /// @notice A new holder may retry a parcel the previous holder got refused.
    function test_resubmissionAfterTransferFollowsTheNewHolder() public {
        uint256 tokenId = _classWithOneEntitlement();
        _submit(tokenId, buyer);
        _decide(tokenId, Verdict.Refused);

        vm.prank(buyer);
        entitlement.transferFrom(buyer, stranger, tokenId);

        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(ActivationRegistry.NotTokenOwner.selector, tokenId, buyer)
        );
        registry.submitParcel(tokenId, PARCEL_HASH, DOCS_HASH);

        vm.prank(stranger);
        registry.submitParcel(tokenId, keccak256("their-parcel"), DOCS_HASH);

        (,,,,,,,, uint32 attempt,) = registry.activations(tokenId);
        assertEq(attempt, 2, "attempt counter did not survive the transfer");
    }

    function testFuzz_attemptCountsEveryRefusedSubmission(uint8 rounds) public {
        rounds = uint8(bound(rounds, 1, 8));
        uint256 tokenId = _classWithOneEntitlement();

        for (uint256 i = 0; i < rounds; i++) {
            _submit(tokenId, buyer);
            _decide(tokenId, Verdict.Refused);
            _assertState(tokenId, EntitlementState.Available);
        }

        (,, bytes32 decisionHash,,,,,, uint32 attempt,) = registry.activations(tokenId);
        assertEq(attempt, rounds);
        assertEq(decisionHash, DECISION_HASH, "final refusal left no commitment");
    }

    // ---------------------------------------------------------------------
    // Carrier evidence — oracle only, state gated
    // ---------------------------------------------------------------------

    function test_recordCarrierStoresBothHashes() public {
        uint256 tokenId = _classWithOneEntitlement();
        _submit(tokenId, buyer);
        _decide(tokenId, Verdict.Approved);

        bytes32 refHash = keccak256("SB-TRACK-001");
        bytes32 rawHash = keccak256("{raw carrier response}");

        vm.expectEmit(true, false, false, true, address(registry));
        emit CarrierRecorded(tokenId, refHash, rawHash);

        vm.prank(oracle);
        registry.recordCarrier(tokenId, refHash, rawHash);

        (,,, bytes32 carrierRefHash, bytes32 carrierRawHash,,,,,) = registry.activations(tokenId);
        assertEq(carrierRefHash, refHash);
        assertEq(carrierRawHash, rawHash, "raw carrier payload left uncommitted");
    }

    function test_onlyOracleMayRecordCarrier() public {
        uint256 tokenId = _classWithOneEntitlement();
        _submit(tokenId, buyer);
        _decide(tokenId, Verdict.Approved);

        address[3] memory outsiders = [compliance, buyer, admin];
        for (uint256 i = 0; i < outsiders.length; i++) {
            vm.prank(outsiders[i]);
            vm.expectRevert(
                abi.encodeWithSelector(
                    IAccessControl.AccessControlUnauthorizedAccount.selector,
                    outsiders[i],
                    Roles.ORACLE_ROLE
                )
            );
            registry.recordCarrier(tokenId, keccak256("ref"), keccak256("raw"));
        }
    }

    /// @notice A carrier reference before activation would be evidence of a
    ///         shipment nobody approved.
    function test_recordCarrierBeforeActivationReverts() public {
        uint256 tokenId = _classWithOneEntitlement();

        vm.prank(oracle);
        vm.expectRevert(abi.encodeWithSelector(ActivationRegistry.NotActivated.selector, tokenId));
        registry.recordCarrier(tokenId, keccak256("ref"), keccak256("raw"));

        _submit(tokenId, buyer);
        vm.prank(oracle);
        vm.expectRevert(abi.encodeWithSelector(ActivationRegistry.NotActivated.selector, tokenId));
        registry.recordCarrier(tokenId, keccak256("ref"), keccak256("raw"));
    }

    function test_recordCarrierAfterRefusalReverts() public {
        uint256 tokenId = _classWithOneEntitlement();
        _submit(tokenId, buyer);
        _decide(tokenId, Verdict.Refused);

        vm.prank(oracle);
        vm.expectRevert(abi.encodeWithSelector(ActivationRegistry.NotActivated.selector, tokenId));
        registry.recordCarrier(tokenId, keccak256("ref"), keccak256("raw"));
    }

    /// @notice Permitted through the whole in-flight window, because carriers
    ///         amend references mid-shipment.
    function test_recordCarrierPermittedInLabelCreatedAndInTransit() public {
        uint256 tokenId = _classWithOneEntitlement();
        _submit(tokenId, buyer);
        _decide(tokenId, Verdict.Approved);

        vm.prank(oracle);
        entitlement.recordLabel(tokenId);
        vm.prank(oracle);
        registry.recordCarrier(tokenId, keccak256("ref-label"), keccak256("raw-label"));

        vm.prank(oracle);
        entitlement.recordPickup(tokenId);
        vm.prank(oracle);
        registry.recordCarrier(tokenId, keccak256("ref-transit"), keccak256("raw-transit"));

        (,,, bytes32 carrierRefHash,,,,,,) = registry.activations(tokenId);
        assertEq(carrierRefHash, keccak256("ref-transit"), "amendment not recorded");
    }

    function test_recordCarrierAfterDeliveryReverts() public {
        uint256 tokenId = _classWithOneEntitlement();
        _deliver(tokenId);

        vm.prank(oracle);
        vm.expectRevert(abi.encodeWithSelector(ActivationRegistry.NotActivated.selector, tokenId));
        registry.recordCarrier(tokenId, keccak256("ref"), keccak256("raw"));
    }

    // ---------------------------------------------------------------------
    // Tracking — published only once it is no longer sensitive
    // ---------------------------------------------------------------------

    function test_publishTrackingOnDelivery() public {
        uint256 tokenId = _classWithOneEntitlement();
        _deliver(tokenId);

        vm.expectEmit(true, false, false, true, address(registry));
        emit TrackingPublished(tokenId, "SB-TRACK-001");

        vm.prank(oracle);
        registry.publishTracking(tokenId, "SB-TRACK-001");

        assertEq(registry.trackingNumber(tokenId), "SB-TRACK-001");
    }

    /// @notice A live tracking number is an attack surface on a real parcel, so
    ///         every pre-delivery state refuses to publish it.
    function test_trackingStaysPrivateUntilDelivered() public {
        uint256 tokenId = _classWithOneEntitlement();

        vm.prank(oracle);
        vm.expectRevert(abi.encodeWithSelector(ActivationRegistry.NotActivated.selector, tokenId));
        registry.publishTracking(tokenId, "SB-TRACK-001");

        _submit(tokenId, buyer);
        vm.prank(oracle);
        vm.expectRevert(abi.encodeWithSelector(ActivationRegistry.NotActivated.selector, tokenId));
        registry.publishTracking(tokenId, "SB-TRACK-001");

        _decide(tokenId, Verdict.Approved);
        vm.prank(oracle);
        vm.expectRevert(abi.encodeWithSelector(ActivationRegistry.NotActivated.selector, tokenId));
        registry.publishTracking(tokenId, "SB-TRACK-001");

        vm.startPrank(oracle);
        entitlement.recordLabel(tokenId);
        vm.expectRevert(abi.encodeWithSelector(ActivationRegistry.NotActivated.selector, tokenId));
        registry.publishTracking(tokenId, "SB-TRACK-001");

        entitlement.recordPickup(tokenId);
        vm.expectRevert(abi.encodeWithSelector(ActivationRegistry.NotActivated.selector, tokenId));
        registry.publishTracking(tokenId, "SB-TRACK-001");
        vm.stopPrank();

        assertEq(bytes(registry.trackingNumber(tokenId)).length, 0);
    }

    function test_onlyOracleMayPublishTracking() public {
        uint256 tokenId = _classWithOneEntitlement();
        _deliver(tokenId);

        address[3] memory outsiders = [compliance, buyer, admin];
        for (uint256 i = 0; i < outsiders.length; i++) {
            vm.prank(outsiders[i]);
            vm.expectRevert(
                abi.encodeWithSelector(
                    IAccessControl.AccessControlUnauthorizedAccount.selector,
                    outsiders[i],
                    Roles.ORACLE_ROLE
                )
            );
            registry.publishTracking(tokenId, "SB-TRACK-001");
        }

        assertEq(bytes(registry.trackingNumber(tokenId)).length, 0);
    }

    /// @notice The published number must be checkable against the commitment.
    ///
    /// This is the whole point of revealing it: `keccak256(trackingNumber)` has
    /// to reproduce the `carrierRefHash` recorded while the shipment was live,
    /// or the reveal proves nothing.
    function test_publishedTrackingMatchesTheRecordedCommitment() public {
        uint256 tokenId = _classWithOneEntitlement();
        string memory tracking = "SB-PHC-LOS-77421";

        _submit(tokenId, buyer);
        _decide(tokenId, Verdict.Approved);

        vm.startPrank(oracle);
        registry.recordCarrier(tokenId, keccak256(bytes(tracking)), keccak256("raw"));
        entitlement.recordLabel(tokenId);
        entitlement.recordPickup(tokenId);
        entitlement.recordDelivery(tokenId);
        registry.publishTracking(tokenId, tracking);
        vm.stopPrank();

        (,,, bytes32 carrierRefHash,,,,,,) = registry.activations(tokenId);
        assertEq(
            keccak256(bytes(registry.trackingNumber(tokenId))),
            carrierRefHash,
            "revealed tracking number does not open the on-chain commitment"
        );
    }

    /// @notice The defensive branch: a registry that never saw the submission
    ///         refuses to publish tracking for it.
    ///
    /// Unreachable through a single registry, since delivery implies submission.
    /// It becomes reachable if a second registry is ever wired to the same
    /// entitlement — which is exactly the situation where publishing a tracking
    /// number from an empty local record would be inventing evidence.
    function test_publishTrackingWithoutALocalActivationReverts() public {
        uint256 tokenId = _classWithOneEntitlement();
        _deliver(tokenId);

        ActivationRegistry other = new ActivationRegistry(admin, address(entitlement));
        vm.prank(admin);
        other.grantRole(Roles.ORACLE_ROLE, oracle);

        vm.prank(oracle);
        vm.expectRevert(abi.encodeWithSelector(ActivationRegistry.NoActivation.selector, tokenId));
        other.publishTracking(tokenId, "SB-TRACK-001");
    }

    // ---------------------------------------------------------------------
    // Role separation
    // ---------------------------------------------------------------------

    /// @notice Compliance's authority stops at the decision. It cannot write
    ///         carrier evidence, cannot publish tracking, and cannot drive the
    ///         token's state directly.
    function test_complianceCannotWriteCarrierFacts() public {
        uint256 tokenId = _classWithOneEntitlement();
        _deliver(tokenId);

        vm.startPrank(compliance);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, compliance, Roles.ORACLE_ROLE
            )
        );
        registry.recordCarrier(tokenId, keccak256("ref"), keccak256("raw"));

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, compliance, Roles.ORACLE_ROLE
            )
        );
        registry.publishTracking(tokenId, "SB-TRACK-001");

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                compliance,
                Roles.REGISTRY_ROLE
            )
        );
        entitlement.approveActivation(tokenId);

        vm.stopPrank();
    }

    /// @notice Only the registry may drive the review transitions, so a
    ///         compromised compliance key cannot bypass the decision record by
    ///         calling the entitlement directly.
    function test_registryIsTheOnlyRouteIntoReviewTransitions() public {
        uint256 tokenId = _classWithOneEntitlement();

        address[2] memory outsiders = [compliance, oracle];
        for (uint256 i = 0; i < outsiders.length; i++) {
            vm.prank(outsiders[i]);
            vm.expectRevert(
                abi.encodeWithSelector(
                    IAccessControl.AccessControlUnauthorizedAccount.selector,
                    outsiders[i],
                    Roles.REGISTRY_ROLE
                )
            );
            entitlement.submitParcel(tokenId);
        }

        assertTrue(entitlement.hasRole(Roles.REGISTRY_ROLE, address(registry)));
    }
}
