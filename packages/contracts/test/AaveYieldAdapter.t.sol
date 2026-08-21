// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {RouteLockBase} from "./RouteLockBase.t.sol";
import {AaveYieldAdapter} from "../src/AaveYieldAdapter.sol";
import {SettlementEscrow} from "../src/SettlementEscrow.sol";
import {MockAavePool} from "./utils/MockAavePool.sol";
import {Roles} from "../src/RouteLockTypes.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

contract AaveYieldAdapterTest is RouteLockBase {
    MockAavePool internal pool;
    AaveYieldAdapter internal adapter;

    function setUp() public override {
        super.setUp();
        pool = new MockAavePool(address(token));
        adapter = new AaveYieldAdapter(
            address(escrow), address(pool), address(token), address(pool.reserveAToken())
        );

        vm.prank(admin);
        escrow.setCollateralStrategy(address(adapter));
    }

    function test_onlyEscrowCanMoveAavePosition() public {
        vm.expectRevert(abi.encodeWithSelector(AaveYieldAdapter.OnlyEscrow.selector, address(this)));
        adapter.deposit(1);
    }

    function test_investedCollateralBacksMintAndAccruesYield() public {
        _createClass();
        _fundCollateral(OBLIGATION);

        vm.prank(issuer);
        escrow.investCollateral(CLASS_ID, OBLIGATION);

        (,,, uint256 rawCollateral,,) = escrow.classEscrow(CLASS_ID);
        assertEq(rawCollateral, 0);
        assertEq(escrow.totalBacking(CLASS_ID), OBLIGATION);
        assertTrue(escrow.isFullyBacked(CLASS_ID));

        pool.addYield(address(adapter), 1_000_000);
        assertEq(escrow.totalBacking(CLASS_ID), OBLIGATION + 1_000_000);

        _buy(buyer);
        (,,, uint256 rawAfterMint, uint256 obligationAfterMint, ) = escrow.classEscrow(CLASS_ID);
        assertEq(rawAfterMint, 0);
        assertEq(obligationAfterMint, OBLIGATION);
        assertEq(escrow.totalBacking(CLASS_ID), OBLIGATION + 1_000_000);
    }

    function test_withdrawalUsesAaveSharesWhenRawCollateralIsEmpty() public {
        _createClass();
        _fundCollateral(OBLIGATION * 2);

        vm.prank(issuer);
        escrow.investCollateral(CLASS_ID, OBLIGATION * 2);
        _buy(buyer);

        vm.prank(issuer);
        escrow.withdrawCollateral(CLASS_ID, OBLIGATION);

        assertEq(token.balanceOf(issuer), OBLIGATION);
        assertTrue(escrow.isFullyBacked(CLASS_ID));
        assertEq(escrow.totalBacking(CLASS_ID), OBLIGATION);
    }

    function test_withdrawalCannotBreakBackingWithAaveCollateral() public {
        _createClass();
        _fundCollateral(OBLIGATION);

        vm.prank(issuer);
        escrow.investCollateral(CLASS_ID, OBLIGATION);
        _buy(buyer);

        vm.prank(issuer);
        vm.expectRevert(
            abi.encodeWithSelector(
                SettlementEscrow.InsufficientCollateral.selector, CLASS_ID, OBLIGATION - 1, OBLIGATION
            )
        );
        escrow.withdrawCollateral(CLASS_ID, 1);
    }

    function test_investmentRequiresIssuerAndConfiguredAsset() public {
        _createClass();
        _fundCollateral(OBLIGATION);

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, Roles.ISSUER_ROLE
            )
        );
        escrow.investCollateral(CLASS_ID, 1);
    }

    function test_adminEmergencyUnwindReturnsStrategyAssetsToEscrow() public {
        _createClass();
        _fundCollateral(OBLIGATION);

        vm.prank(issuer);
        escrow.investCollateral(CLASS_ID, OBLIGATION);
        pool.addYield(address(adapter), 500_000);

        bytes32[] memory classes = new bytes32[](1);
        classes[0] = CLASS_ID;
        vm.prank(admin);
        escrow.emergencyUnwindStrategy(classes);

        assertEq(adapter.totalShares(), 0);
        assertEq(adapter.totalAssets(), 0);
        assertEq(escrow.strategyShares(CLASS_ID), 0);
        (,,, uint256 rawCollateral,,) = escrow.classEscrow(CLASS_ID);
        assertEq(rawCollateral, OBLIGATION + 500_000);
        assertEq(escrow.totalBacking(CLASS_ID), OBLIGATION + 500_000);
    }

    function test_emergencyUnwindMustNameEveryClass() public {
        bytes32 secondClass = keccak256("PHC-LOS-SECOND");
        _createClass();
        vm.prank(issuer);
        factory.createClass(
            secondClass, TERMS_HASH, address(token), PRICE, OBLIGATION, validUntil, MAX_SUPPLY
        );
        _fundCollateral(OBLIGATION);
        vm.startPrank(issuer);
        token.mint(issuer, OBLIGATION);
        token.approve(address(escrow), OBLIGATION);
        escrow.postCollateral(secondClass, OBLIGATION);
        vm.stopPrank();

        vm.startPrank(issuer);
        escrow.investCollateral(CLASS_ID, OBLIGATION);
        escrow.investCollateral(secondClass, OBLIGATION);
        vm.stopPrank();

        bytes32[] memory onlyFirst = new bytes32[](1);
        onlyFirst[0] = CLASS_ID;
        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(SettlementEscrow.IncompleteStrategyUnwind.selector, OBLIGATION)
        );
        escrow.emergencyUnwindStrategy(onlyFirst);

        bytes32[] memory everyClass = new bytes32[](2);
        everyClass[0] = CLASS_ID;
        everyClass[1] = secondClass;
        vm.prank(admin);
        escrow.emergencyUnwindStrategy(everyClass);
        assertEq(adapter.totalShares(), 0);
        assertEq(escrow.strategyShares(CLASS_ID), 0);
        assertEq(escrow.strategyShares(secondClass), 0);
    }
}
