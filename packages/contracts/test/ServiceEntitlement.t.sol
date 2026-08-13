// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {RouteLockBase} from "./RouteLockBase.t.sol";
import {ServiceEntitlement} from "../src/ServiceEntitlement.sol";
import {ActivationRegistry, Verdict} from "../src/ActivationRegistry.sol";
import {EntitlementState, Roles} from "../src/RouteLockTypes.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/// @notice Every edge of the state machine, in both directions: the transitions
///         that must succeed, and the ones that must revert.
contract ServiceEntitlementTest is RouteLockBase {
    // ---------------------------------------------------------------------
    // Minting
    // ---------------------------------------------------------------------

    function test_mint_startsAvailable() public {
        uint256 tokenId = _classWithOneEntitlement();
        _assertState(tokenId, EntitlementState.Available);
        assertEq(entitlement.ownerOf(tokenId), buyer);
        assertEq(entitlement.classOf(tokenId), CLASS_ID);
        assertEq(entitlement.totalMinted(), 1);
    }

    function test_mint_onlyFactory() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, Roles.FACTORY_ROLE
            )
        );
        entitlement.mint(stranger, CLASS_ID);
    }

    function test_unmintedTokenHasNoState() public view {
        assertEq(uint8(entitlement.stateOf(999)), uint8(EntitlementState.None));
        assertFalse(entitlement.exists(999));
    }

    // ---------------------------------------------------------------------
    // The happy path, one edge at a time
    // ---------------------------------------------------------------------

    function test_fullLifecycle() public {
        uint256 tokenId = _classWithOneEntitlement();

        _submit(tokenId, buyer);
        _assertState(tokenId, EntitlementState.PendingReview);

        _decide(tokenId, Verdict.Approved);
        _assertState(tokenId, EntitlementState.Activated);

        vm.prank(oracle);
        entitlement.recordLabel(tokenId);
        _assertState(tokenId, EntitlementState.LabelCreated);

        vm.prank(oracle);
        entitlement.recordPickup(tokenId);
        _assertState(tokenId, EntitlementState.InTransit);

        vm.prank(oracle);
        entitlement.recordDelivery(tokenId);
        _assertState(tokenId, EntitlementState.Delivered);
    }

    // ---------------------------------------------------------------------
    // Refusal returns the token intact — the path that matters most
    // ---------------------------------------------------------------------

    function test_refusal_returnsTokenToAvailable() public {
        uint256 tokenId = _classWithOneEntitlement();
        _submit(tokenId, buyer);

        _decide(tokenId, Verdict.Refused);

        _assertState(tokenId, EntitlementState.Available);
        assertEq(entitlement.ownerOf(tokenId), buyer, "refusal must not move the token");
    }

    function test_needsInformation_returnsTokenToAvailable() public {
        uint256 tokenId = _classWithOneEntitlement();
        _submit(tokenId, buyer);

        _decide(tokenId, Verdict.NeedsInformation);

        _assertState(tokenId, EntitlementState.Available);
    }

    /// @notice A refused entitlement stays fully usable — including transferable,
    ///         and resubmittable with better information.
    function test_refusedEntitlement_isStillTransferableAndReusable() public {
        uint256 tokenId = _classWithOneEntitlement();
        _submit(tokenId, buyer);
        _decide(tokenId, Verdict.Refused);

        vm.prank(buyer);
        entitlement.transferFrom(buyer, supplier, tokenId);
        assertEq(entitlement.ownerOf(tokenId), supplier);

        _submit(tokenId, supplier);
        _decide(tokenId, Verdict.Approved);
        _assertState(tokenId, EntitlementState.Activated);
    }

    // ---------------------------------------------------------------------
    // Transfer lock
    // ---------------------------------------------------------------------

    function test_transfer_allowedWhileAvailable() public {
        uint256 tokenId = _classWithOneEntitlement();

        vm.prank(buyer);
        entitlement.transferFrom(buyer, supplier, tokenId);

        assertEq(entitlement.ownerOf(tokenId), supplier);
        _assertState(tokenId, EntitlementState.Available);
    }

    function test_transfer_lockedOncePendingReview() public {
        uint256 tokenId = _classWithOneEntitlement();
        _submit(tokenId, buyer);

        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                ServiceEntitlement.TransferLocked.selector, tokenId, EntitlementState.PendingReview
            )
        );
        entitlement.transferFrom(buyer, supplier, tokenId);
    }

    function test_transfer_lockedOnceActivated() public {
        uint256 tokenId = _classWithOneEntitlement();
        _submit(tokenId, buyer);
        _decide(tokenId, Verdict.Approved);

        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                ServiceEntitlement.TransferLocked.selector, tokenId, EntitlementState.Activated
            )
        );
        entitlement.transferFrom(buyer, supplier, tokenId);
    }

    function test_transfer_lockedAfterDelivery() public {
        uint256 tokenId = _classWithOneEntitlement();
        _deliver(tokenId);

        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                ServiceEntitlement.TransferLocked.selector, tokenId, EntitlementState.Delivered
            )
        );
        entitlement.transferFrom(buyer, supplier, tokenId);
    }

    /// @dev An approval granted while Available must not become a way around the
    ///      lock once the token is bound.
    function test_transfer_lockedEvenWithPriorApproval() public {
        uint256 tokenId = _classWithOneEntitlement();

        vm.prank(buyer);
        entitlement.approve(supplier, tokenId);

        _submit(tokenId, buyer);
        _decide(tokenId, Verdict.Approved);

        vm.prank(supplier);
        vm.expectRevert(
            abi.encodeWithSelector(
                ServiceEntitlement.TransferLocked.selector, tokenId, EntitlementState.Activated
            )
        );
        entitlement.transferFrom(buyer, supplier, tokenId);
    }

    // ---------------------------------------------------------------------
    // Invalid transitions
    // ---------------------------------------------------------------------

    function test_cannotLabelBeforeActivation() public {
        uint256 tokenId = _classWithOneEntitlement();

        vm.prank(oracle);
        vm.expectRevert(
            abi.encodeWithSelector(
                ServiceEntitlement.InvalidTransition.selector,
                tokenId,
                EntitlementState.Available,
                EntitlementState.LabelCreated
            )
        );
        entitlement.recordLabel(tokenId);
    }

    function test_cannotSkipPickup() public {
        uint256 tokenId = _classWithOneEntitlement();
        _submit(tokenId, buyer);
        _decide(tokenId, Verdict.Approved);

        vm.prank(oracle);
        vm.expectRevert(
            abi.encodeWithSelector(
                ServiceEntitlement.InvalidTransition.selector,
                tokenId,
                EntitlementState.Activated,
                EntitlementState.InTransit
            )
        );
        entitlement.recordPickup(tokenId);
    }

    function test_cannotDeliverTwice() public {
        uint256 tokenId = _classWithOneEntitlement();
        _deliver(tokenId);

        vm.prank(oracle);
        vm.expectRevert(
            abi.encodeWithSelector(
                ServiceEntitlement.InvalidTransition.selector,
                tokenId,
                EntitlementState.Delivered,
                EntitlementState.Delivered
            )
        );
        entitlement.recordDelivery(tokenId);
    }

    function test_transitionOnUnknownTokenReverts() public {
        vm.prank(oracle);
        vm.expectRevert(abi.encodeWithSelector(ServiceEntitlement.UnknownToken.selector, 42));
        entitlement.recordLabel(42);
    }

    // ---------------------------------------------------------------------
    // Role separation on transitions
    // ---------------------------------------------------------------------

    function test_onlyOracleCanRecordCarrierStates() public {
        uint256 tokenId = _classWithOneEntitlement();
        _submit(tokenId, buyer);
        _decide(tokenId, Verdict.Approved);

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, Roles.ORACLE_ROLE
            )
        );
        entitlement.recordLabel(tokenId);
    }

    function test_onlyRegistryCanDriveReview() public {
        uint256 tokenId = _classWithOneEntitlement();

        vm.prank(compliance);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                compliance,
                Roles.REGISTRY_ROLE
            )
        );
        entitlement.approveActivation(tokenId);
    }

    // ---------------------------------------------------------------------
    // Remedy
    // ---------------------------------------------------------------------

    function test_remedy_fromActivated() public {
        uint256 tokenId = _classWithOneEntitlement();
        _submit(tokenId, buyer);
        _decide(tokenId, Verdict.Approved);

        vm.prank(admin);
        entitlement.recordRemedy(tokenId);
        _assertState(tokenId, EntitlementState.Remedied);
    }

    function test_remedy_fromInTransit() public {
        uint256 tokenId = _classWithOneEntitlement();
        _submit(tokenId, buyer);
        _decide(tokenId, Verdict.Approved);
        vm.startPrank(oracle);
        entitlement.recordLabel(tokenId);
        entitlement.recordPickup(tokenId);
        vm.stopPrank();

        vm.prank(admin);
        entitlement.recordRemedy(tokenId);
        _assertState(tokenId, EntitlementState.Remedied);
    }

    function test_remedy_notReachableFromAvailable() public {
        uint256 tokenId = _classWithOneEntitlement();

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                ServiceEntitlement.InvalidTransition.selector,
                tokenId,
                EntitlementState.Available,
                EntitlementState.Remedied
            )
        );
        entitlement.recordRemedy(tokenId);
    }

    function test_remedy_notReachableAfterDelivery() public {
        uint256 tokenId = _classWithOneEntitlement();
        _deliver(tokenId);

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                ServiceEntitlement.InvalidTransition.selector,
                tokenId,
                EntitlementState.Delivered,
                EntitlementState.Remedied
            )
        );
        entitlement.recordRemedy(tokenId);
    }

    // ---------------------------------------------------------------------
    // Expiry
    // ---------------------------------------------------------------------

    function test_expire_afterValidity_isPermissionless() public {
        uint256 tokenId = _classWithOneEntitlement();
        vm.warp(validUntil + 1);

        vm.prank(stranger);
        entitlement.expire(tokenId);
        _assertState(tokenId, EntitlementState.Expired);
    }

    function test_expire_revertsBeforeValidity() public {
        uint256 tokenId = _classWithOneEntitlement();

        vm.expectRevert(
            abi.encodeWithSelector(ServiceEntitlement.NotYetExpired.selector, tokenId, validUntil)
        );
        entitlement.expire(tokenId);
    }

    function test_expire_onlyFromAvailable() public {
        uint256 tokenId = _classWithOneEntitlement();
        _submit(tokenId, buyer);
        vm.warp(validUntil + 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                ServiceEntitlement.InvalidTransition.selector,
                tokenId,
                EntitlementState.PendingReview,
                EntitlementState.Expired
            )
        );
        entitlement.expire(tokenId);
    }

    function test_expire_unknownTokenReverts() public {
        vm.warp(validUntil + 1);
        vm.expectRevert(abi.encodeWithSelector(ServiceEntitlement.UnknownToken.selector, 7));
        entitlement.expire(7);
    }

    function test_expiredTokenIsNotTransferable() public {
        uint256 tokenId = _classWithOneEntitlement();
        vm.warp(validUntil + 1);
        entitlement.expire(tokenId);

        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                ServiceEntitlement.TransferLocked.selector, tokenId, EntitlementState.Expired
            )
        );
        entitlement.transferFrom(buyer, supplier, tokenId);
    }

    // ---------------------------------------------------------------------
    // Wiring
    // ---------------------------------------------------------------------

    function test_setClasses_isOneTime() public {
        vm.prank(admin);
        vm.expectRevert(ServiceEntitlement.FactoryAlreadySet.selector);
        entitlement.setClasses(address(0xBEEF));
    }

    function test_setClasses_onlyAdmin() public {
        ServiceEntitlement fresh = new ServiceEntitlement("x", "x", admin);
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, Roles.ADMIN_ROLE
            )
        );
        fresh.setClasses(address(factory));
    }

    function test_constructor_rejectsZeroAdmin() public {
        vm.expectRevert(ServiceEntitlement.ZeroAddress.selector);
        new ServiceEntitlement("x", "x", address(0));
    }
}
