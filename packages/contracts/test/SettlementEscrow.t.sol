// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {RouteLockBase} from "./RouteLockBase.t.sol";
import {SettlementEscrow} from "../src/SettlementEscrow.sol";
import {ActivationRegistry, Verdict} from "../src/ActivationRegistry.sol";
import {Roles} from "../src/RouteLockTypes.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

contract SettlementEscrowTest is RouteLockBase {
    // =====================================================================
    // The rule the whole design rests on: the AI never touches money.
    // =====================================================================

    /// @notice Required by the specification: `COMPLIANCE_ROLE` cannot move funds.
    ///
    /// Asserted against every value-moving entry point on the escrow, rather
    /// than against one representative function, so adding a new escrow function
    /// without considering compliance access makes this test fail.
    function test_complianceRoleCannotMoveFunds() public {
        uint256 tokenId = _classWithOneEntitlement();
        _submit(tokenId, buyer);
        _decide(tokenId, Verdict.Approved);

        vm.startPrank(compliance);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, compliance, Roles.ORACLE_ROLE
            )
        );
        escrow.releaseToIssuer(tokenId);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, compliance, Roles.ORACLE_ROLE
            )
        );
        escrow.refundBuyer(tokenId);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                compliance,
                Roles.FACTORY_ROLE
            )
        );
        escrow.recordMint(99, CLASS_ID, compliance, PRICE);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                compliance,
                Roles.FACTORY_ROLE
            )
        );
        escrow.registerClass(keccak256("other"), compliance, address(token), 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                compliance,
                Roles.ISSUER_ROLE
            )
        );
        escrow.withdrawCollateral(CLASS_ID, 1);

        vm.stopPrank();

        // And nothing leaked regardless: the deposit is still held, unsettled.
        (,, uint256 amount, bool settled) = escrow.deposits(tokenId);
        assertEq(amount, PRICE);
        assertFalse(settled);
        assertEq(token.balanceOf(compliance), 0);
    }

    /// @notice The structural half: the role cannot even be granted here.
    ///
    /// Not merely "we did not grant it" — no admin, now or later, can grant it.
    function test_escrowRefusesToGrantComplianceRole() public {
        vm.prank(admin);
        vm.expectRevert(SettlementEscrow.ComplianceRoleForbiddenHere.selector);
        escrow.grantRole(Roles.COMPLIANCE_ROLE, compliance);

        assertFalse(escrow.hasRole(Roles.COMPLIANCE_ROLE, compliance));
    }

    /// @notice Approval by compliance must not, by itself, move any money.
    function test_activationAloneReleasesNothing() public {
        uint256 tokenId = _classWithOneEntitlement();
        uint256 escrowBalanceBefore = token.balanceOf(address(escrow));

        _submit(tokenId, buyer);
        _decide(tokenId, Verdict.Approved);

        assertEq(token.balanceOf(address(escrow)), escrowBalanceBefore, "escrow balance changed on approval");
        assertEq(escrow.claimable(issuer, address(token)), 0, "issuer became payable on AI approval alone");
    }

    // =====================================================================
    // Collateral backing
    // =====================================================================

    function test_mintRevertsWhenUncollateralized() public {
        _createClass();
        // No collateral posted at all.
        token.mint(buyer, PRICE);
        vm.startPrank(buyer);
        token.approve(address(escrow), PRICE);
        vm.expectRevert(
            abi.encodeWithSelector(
                SettlementEscrow.InsufficientCollateral.selector, CLASS_ID, 0, OBLIGATION
            )
        );
        factory.mint(CLASS_ID, buyer);
        vm.stopPrank();
    }

    function test_mintRevertsWhenCollateralCoversOnlyPreviousUnits() public {
        _createClass();
        _fundCollateral(OBLIGATION); // exactly one unit of backing

        _buy(buyer); // consumes it

        token.mint(buyer, PRICE);
        vm.startPrank(buyer);
        token.approve(address(escrow), PRICE);
        vm.expectRevert(
            abi.encodeWithSelector(
                SettlementEscrow.InsufficientCollateral.selector,
                CLASS_ID,
                OBLIGATION,
                OBLIGATION * 2
            )
        );
        factory.mint(CLASS_ID, buyer);
        vm.stopPrank();
    }

    function test_collateralWithdrawalCannotBreakBacking() public {
        _createClass();
        _fundCollateral(OBLIGATION * 2);
        _buy(buyer); // one outstanding unit -> obligation == OBLIGATION

        vm.prank(issuer);
        vm.expectRevert(
            abi.encodeWithSelector(
                SettlementEscrow.InsufficientCollateral.selector,
                CLASS_ID,
                OBLIGATION - 1,
                OBLIGATION
            )
        );
        escrow.withdrawCollateral(CLASS_ID, OBLIGATION + 1);
    }

    function test_collateralWithdrawalDownToObligationSucceeds() public {
        _createClass();
        _fundCollateral(OBLIGATION * 2);
        _buy(buyer);

        vm.prank(issuer);
        escrow.withdrawCollateral(CLASS_ID, OBLIGATION);

        assertTrue(escrow.isFullyBacked(CLASS_ID));
        assertEq(token.balanceOf(issuer), OBLIGATION);
    }

    function test_onlyIssuerWithdrawsCollateral() public {
        _createClass();
        _fundCollateral(OBLIGATION);

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, Roles.ISSUER_ROLE
            )
        );
        escrow.withdrawCollateral(CLASS_ID, 1);
    }

    /// @notice The invariant, stated directly: collateral always covers
    ///         outstanding obligations, whatever sequence of mints occurs.
    function testFuzz_alwaysFullyBacked(uint8 mintCount) public {
        mintCount = uint8(bound(mintCount, 0, MAX_SUPPLY));
        _createClass();
        _fundCollateral(OBLIGATION * MAX_SUPPLY);

        for (uint256 i = 0; i < mintCount; i++) {
            _buy(buyer);
            assertTrue(escrow.isFullyBacked(CLASS_ID), "backing invariant broken mid-sequence");
        }
        assertTrue(escrow.isFullyBacked(CLASS_ID));
    }

    // =====================================================================
    // Settlement
    // =====================================================================

    function test_releaseMakesIssuerPayable() public {
        uint256 tokenId = _classWithOneEntitlement();
        _submit(tokenId, buyer);
        _decide(tokenId, Verdict.Approved);

        vm.startPrank(oracle);
        entitlement.recordLabel(tokenId);
        escrow.releaseToIssuer(tokenId);
        vm.stopPrank();

        assertEq(escrow.claimable(issuer, address(token)), PRICE);

        vm.prank(issuer);
        escrow.claim(address(token));
        assertEq(token.balanceOf(issuer), PRICE);
        assertEq(escrow.claimable(issuer, address(token)), 0);
    }

    function test_cannotReleaseTwice() public {
        uint256 tokenId = _classWithOneEntitlement();
        _submit(tokenId, buyer);
        _decide(tokenId, Verdict.Approved);

        vm.startPrank(oracle);
        escrow.releaseToIssuer(tokenId);
        vm.expectRevert(abi.encodeWithSelector(SettlementEscrow.AlreadySettled.selector, tokenId));
        escrow.releaseToIssuer(tokenId);
        vm.stopPrank();
    }

    function test_refundReturnsBuyerFunds() public {
        uint256 tokenId = _classWithOneEntitlement();
        assertEq(token.balanceOf(buyer), 0, "buyer paid");

        vm.prank(oracle);
        escrow.refundBuyer(tokenId);

        assertEq(token.balanceOf(buyer), PRICE, "buyer not made whole");
    }

    function test_refundReleasesTheObligation() public {
        _createClass();
        _fundCollateral(OBLIGATION);
        uint256 tokenId = _buy(buyer);

        vm.prank(oracle);
        escrow.refundBuyer(tokenId);

        // Obligation discharged, so collateral is withdrawable again.
        vm.prank(issuer);
        escrow.withdrawCollateral(CLASS_ID, OBLIGATION);
        assertEq(token.balanceOf(issuer), OBLIGATION);
    }

    function test_cannotSettleUnknownDeposit() public {
        vm.prank(oracle);
        vm.expectRevert(abi.encodeWithSelector(SettlementEscrow.UnknownDeposit.selector, 12345));
        escrow.releaseToIssuer(12345);
    }

    function test_claimWithNothingOwedReverts() public {
        vm.prank(issuer);
        vm.expectRevert(SettlementEscrow.NothingToClaim.selector);
        escrow.claim(address(token));
    }

    function test_postCollateralOnUnknownClassReverts() public {
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(SettlementEscrow.UnknownClass.selector, CLASS_ID));
        escrow.postCollateral(CLASS_ID, 1);
    }

    function test_postZeroCollateralReverts() public {
        _createClass();
        vm.prank(issuer);
        vm.expectRevert(SettlementEscrow.ZeroAmount.selector);
        escrow.postCollateral(CLASS_ID, 0);
    }

    function test_constructorRejectsZeroAdmin() public {
        vm.expectRevert(SettlementEscrow.ZeroAddress.selector);
        new SettlementEscrow(address(0));
    }
}
