// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {RouteLockBase} from "./RouteLockBase.t.sol";
import {EntitlementFactory} from "../src/EntitlementFactory.sol";
import {ServiceSpec, Roles} from "../src/RouteLockTypes.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

contract EntitlementFactoryTest is RouteLockBase {
    // ---------------------------------------------------------------------
    // Issuer gating
    // ---------------------------------------------------------------------

    function test_unregisteredIssuerCannotCreateClass() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(EntitlementFactory.IssuerNotRegistered.selector, stranger)
        );
        factory.createClass(
            CLASS_ID, TERMS_HASH, address(token), PRICE, OBLIGATION, validUntil, MAX_SUPPLY
        );
    }

    function test_pausedIssuerCannotCreateClass() public {
        vm.prank(admin);
        factory.pauseIssuer(issuer, true);

        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(EntitlementFactory.IssuerPaused.selector, issuer));
        factory.createClass(
            CLASS_ID, TERMS_HASH, address(token), PRICE, OBLIGATION, validUntil, MAX_SUPPLY
        );
    }

    function test_pausedIssuerCannotSellMore() public {
        _createClass();
        _fundCollateral(OBLIGATION * MAX_SUPPLY);

        vm.prank(admin);
        factory.pauseIssuer(issuer, true);

        token.mint(buyer, PRICE);
        vm.startPrank(buyer);
        token.approve(address(escrow), PRICE);
        vm.expectRevert(abi.encodeWithSelector(EntitlementFactory.IssuerPaused.selector, issuer));
        factory.mint(CLASS_ID, buyer);
        vm.stopPrank();
    }

    /// @notice Pausing an issuer must not strand entitlements already sold.
    function test_pausingIssuerDoesNotBreakExistingEntitlements() public {
        uint256 tokenId = _classWithOneEntitlement();

        vm.prank(admin);
        factory.pauseIssuer(issuer, true);

        vm.prank(buyer);
        entitlement.transferFrom(buyer, supplier, tokenId);
        assertEq(entitlement.ownerOf(tokenId), supplier);
    }

    function test_onlyAdminRegistersIssuers() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, Roles.ADMIN_ROLE
            )
        );
        factory.registerIssuer(stranger);
    }

    function test_cannotPauseUnregisteredIssuer() public {
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(EntitlementFactory.IssuerNotRegistered.selector, stranger)
        );
        factory.pauseIssuer(stranger, true);
    }

    // ---------------------------------------------------------------------
    // Class creation
    // ---------------------------------------------------------------------

    function test_duplicateClassReverts() public {
        _createClass();
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(EntitlementFactory.ClassExists.selector, CLASS_ID));
        factory.createClass(
            CLASS_ID, TERMS_HASH, address(token), PRICE, OBLIGATION, validUntil, MAX_SUPPLY
        );
    }

    function test_validityInPastReverts() public {
        uint64 past = uint64(block.timestamp);
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(EntitlementFactory.ValidityInPast.selector, past));
        factory.createClass(CLASS_ID, TERMS_HASH, address(token), PRICE, OBLIGATION, past, MAX_SUPPLY);
    }

    function test_zeroSupplyReverts() public {
        vm.prank(issuer);
        vm.expectRevert(EntitlementFactory.ZeroSupply.selector);
        factory.createClass(CLASS_ID, TERMS_HASH, address(token), PRICE, OBLIGATION, validUntil, 0);
    }

    function test_zeroSettlementTokenReverts() public {
        vm.prank(issuer);
        vm.expectRevert(EntitlementFactory.ZeroAddress.selector);
        factory.createClass(CLASS_ID, TERMS_HASH, address(0), PRICE, OBLIGATION, validUntil, MAX_SUPPLY);
    }

    // ---------------------------------------------------------------------
    // Supply
    // ---------------------------------------------------------------------

    function test_supplyExhausts() public {
        vm.prank(issuer);
        factory.createClass(CLASS_ID, TERMS_HASH, address(token), PRICE, OBLIGATION, validUntil, 1);
        _fundCollateral(OBLIGATION * 2);

        _buy(buyer);

        token.mint(buyer, PRICE);
        vm.startPrank(buyer);
        token.approve(address(escrow), PRICE);
        vm.expectRevert(abi.encodeWithSelector(EntitlementFactory.SupplyExhausted.selector, CLASS_ID, 1));
        factory.mint(CLASS_ID, buyer);
        vm.stopPrank();
    }

    function test_increaseSupplyAllowsMoreMints() public {
        vm.prank(issuer);
        factory.createClass(CLASS_ID, TERMS_HASH, address(token), PRICE, OBLIGATION, validUntil, 1);
        _fundCollateral(OBLIGATION * 3);
        _buy(buyer);

        vm.prank(issuer);
        factory.increaseSupply(CLASS_ID, 3);

        _buy(buyer);
        assertEq(factory.getClass(CLASS_ID).minted, 2);
    }

    function test_supplyCannotShrink() public {
        _createClass();
        vm.prank(issuer);
        vm.expectRevert(
            abi.encodeWithSelector(
                EntitlementFactory.SupplyCannotShrink.selector, CLASS_ID, MAX_SUPPLY, MAX_SUPPLY - 1
            )
        );
        factory.increaseSupply(CLASS_ID, MAX_SUPPLY - 1);
    }

    function test_onlyClassIssuerIncreasesSupply() public {
        _createClass();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(EntitlementFactory.NotClassIssuer.selector, CLASS_ID, stranger)
        );
        factory.increaseSupply(CLASS_ID, MAX_SUPPLY + 1);
    }

    /// @notice `validUntil` is a term the buyer paid for. Raising supply must not
    ///         be a back door to changing it.
    function test_increaseSupplyLeavesValidityUntouched() public {
        _createClass();
        uint64 before = factory.getClass(CLASS_ID).validUntil;

        vm.prank(issuer);
        factory.increaseSupply(CLASS_ID, MAX_SUPPLY + 5);

        assertEq(factory.getClass(CLASS_ID).validUntil, before, "validUntil is not immutable");
    }

    /// @notice No call sequence mints past `maxSupply`.
    function testFuzz_neverExceedsMaxSupply(uint8 attempts) public {
        attempts = uint8(bound(attempts, 1, 25));
        _createClass();
        _fundCollateral(OBLIGATION * 100);

        uint256 succeeded;
        for (uint256 i = 0; i < attempts; i++) {
            token.mint(buyer, PRICE);
            vm.startPrank(buyer);
            token.approve(address(escrow), PRICE);
            try factory.mint(CLASS_ID, buyer) {
                succeeded++;
            } catch {}
            vm.stopPrank();

            assertLe(factory.getClass(CLASS_ID).minted, MAX_SUPPLY, "minted exceeded maxSupply");
        }
        assertLe(succeeded, MAX_SUPPLY);
    }

    // ---------------------------------------------------------------------
    // Class pause and expiry
    // ---------------------------------------------------------------------

    function test_pausedClassCannotMint() public {
        _createClass();
        _fundCollateral(OBLIGATION * MAX_SUPPLY);

        vm.prank(issuer);
        factory.pauseClass(CLASS_ID, true);

        token.mint(buyer, PRICE);
        vm.startPrank(buyer);
        token.approve(address(escrow), PRICE);
        vm.expectRevert(abi.encodeWithSelector(EntitlementFactory.ClassIsPaused.selector, CLASS_ID));
        factory.mint(CLASS_ID, buyer);
        vm.stopPrank();
    }

    function test_expiredClassCannotMint() public {
        _createClass();
        _fundCollateral(OBLIGATION * MAX_SUPPLY);
        vm.warp(validUntil + 1);

        token.mint(buyer, PRICE);
        vm.startPrank(buyer);
        token.approve(address(escrow), PRICE);
        vm.expectRevert(
            abi.encodeWithSelector(EntitlementFactory.ClassExpired.selector, CLASS_ID, validUntil)
        );
        factory.mint(CLASS_ID, buyer);
        vm.stopPrank();
    }

    function test_mintOnUnknownClassReverts() public {
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(EntitlementFactory.NoSuchClass.selector, keccak256("nope"))
        );
        factory.mint(keccak256("nope"), buyer);
    }

    function test_mintToZeroAddressReverts() public {
        _createClass();
        _fundCollateral(OBLIGATION);
        vm.prank(buyer);
        vm.expectRevert(EntitlementFactory.ZeroAddress.selector);
        factory.mint(CLASS_ID, address(0));
    }

    // ---------------------------------------------------------------------
    // Purchase mechanics
    // ---------------------------------------------------------------------

    /// @notice Funds move buyer -> escrow directly. The factory never holds them.
    function test_factoryNeverHoldsFunds() public {
        _classWithOneEntitlement();
        assertEq(token.balanceOf(address(factory)), 0);
        assertEq(token.balanceOf(address(escrow)), PRICE + OBLIGATION * MAX_SUPPLY);
    }

    function test_buyerCanMintToAnotherAddress() public {
        _createClass();
        _fundCollateral(OBLIGATION * MAX_SUPPLY);
        uint256 tokenId = _buy(supplier);

        assertEq(entitlement.ownerOf(tokenId), supplier, "minted to the wrong holder");
    }

    function test_constructorRejectsZeroAddresses() public {
        vm.expectRevert(EntitlementFactory.ZeroAddress.selector);
        new EntitlementFactory(address(0), address(entitlement), address(escrow));

        vm.expectRevert(EntitlementFactory.ZeroAddress.selector);
        new EntitlementFactory(admin, address(0), address(escrow));

        vm.expectRevert(EntitlementFactory.ZeroAddress.selector);
        new EntitlementFactory(admin, address(entitlement), address(0));
    }

    function test_registerZeroIssuerReverts() public {
        vm.prank(admin);
        vm.expectRevert(EntitlementFactory.ZeroAddress.selector);
        factory.registerIssuer(address(0));
    }

    /// @notice Pausing is the issuer's own control over their own classes.
    ///         Neither a stranger nor the protocol admin may pause for them.
    function test_onlyClassIssuerPausesTheClass() public {
        _createClass();

        address[2] memory outsiders = [stranger, admin];
        for (uint256 i = 0; i < outsiders.length; i++) {
            vm.prank(outsiders[i]);
            vm.expectRevert(
                abi.encodeWithSelector(
                    EntitlementFactory.NotClassIssuer.selector, CLASS_ID, outsiders[i]
                )
            );
            factory.pauseClass(CLASS_ID, true);
        }

        assertFalse(factory.getClass(CLASS_ID).paused);
    }

    function test_pauseClassOnUnknownClassReverts() public {
        bytes32 unknown = keccak256("no-such-class");

        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(EntitlementFactory.NoSuchClass.selector, unknown));
        factory.pauseClass(unknown, true);
    }

    function test_issuerCanUnpauseTheirOwnClass() public {
        _createClass();
        _fundCollateral(OBLIGATION * MAX_SUPPLY);

        vm.prank(issuer);
        factory.pauseClass(CLASS_ID, true);
        assertTrue(factory.getClass(CLASS_ID).paused);

        vm.prank(issuer);
        factory.pauseClass(CLASS_ID, false);
        assertFalse(factory.getClass(CLASS_ID).paused);

        _buy(buyer); // selling resumes
    }

    // ---------------------------------------------------------------------
    // IEntitlementClasses — the read surface other contracts depend on
    // ---------------------------------------------------------------------

    /// @notice `ServiceEntitlement.expire` reads `classValidUntil` through this
    ///         interface, so the three views are asserted directly rather than
    ///         only via the one caller that happens to use one of them.
    function test_classViewsReportTheClass() public {
        _createClass();

        assertEq(factory.classIssuer(CLASS_ID), issuer);
        assertEq(factory.classValidUntil(CLASS_ID), validUntil);
        assertTrue(factory.classExists(CLASS_ID));
    }

    function test_classViewsOnUnknownClassReturnEmpty() public view {
        bytes32 unknown = keccak256("no-such-class");

        assertEq(factory.classIssuer(unknown), address(0));
        assertEq(factory.classValidUntil(unknown), 0);
        assertFalse(factory.classExists(unknown), "unknown class reported as existing");
    }
}
