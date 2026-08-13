// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {ServiceEntitlement} from "../src/ServiceEntitlement.sol";
import {SettlementEscrow} from "../src/SettlementEscrow.sol";
import {EntitlementFactory} from "../src/EntitlementFactory.sol";
import {ActivationRegistry, Verdict} from "../src/ActivationRegistry.sol";
import {FulfilmentReceipt} from "../src/FulfilmentReceipt.sol";
import {Roles, EntitlementState} from "../src/RouteLockTypes.sol";
import {TestERC20} from "./utils/TestERC20.sol";

/// @notice Shared deployment and wiring for every test.
///
/// The wiring here mirrors the deployment script exactly, so a role that is
/// wrong in production is wrong in the tests too rather than being papered over
/// by a permissive fixture.
abstract contract RouteLockBase is Test {
    ServiceEntitlement internal entitlement;
    SettlementEscrow internal escrow;
    EntitlementFactory internal factory;
    ActivationRegistry internal registry;
    FulfilmentReceipt internal receipt;
    TestERC20 internal token;

    address internal admin = makeAddr("admin");
    address internal issuer = makeAddr("issuer");
    address internal buyer = makeAddr("buyer");
    address internal supplier = makeAddr("supplier");
    address internal oracle = makeAddr("oracle");
    address internal compliance = makeAddr("compliance");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant CLASS_ID = keccak256("PHC-LOS-1KG-STD");
    bytes32 internal constant TERMS_HASH = keccak256("terms-v1");

    uint256 internal constant PRICE = 12_000_000; // 12.00 tUSD
    uint256 internal constant OBLIGATION = 20_000_000; // 20.00 tUSD owed per unit if unfulfilled
    uint32 internal constant MAX_SUPPLY = 10;

    uint64 internal validUntil;

    function setUp() public virtual {
        validUntil = uint64(block.timestamp + 30 days);

        token = new TestERC20();

        entitlement = new ServiceEntitlement("RouteLock Entitlement", "RLE", admin);
        escrow = new SettlementEscrow(admin);
        factory = new EntitlementFactory(admin, address(entitlement), address(escrow));
        registry = new ActivationRegistry(admin, address(entitlement));
        receipt = new FulfilmentReceipt(admin);

        vm.startPrank(admin);
        entitlement.setClasses(address(factory));
        entitlement.grantRole(Roles.FACTORY_ROLE, address(factory));
        entitlement.grantRole(Roles.REGISTRY_ROLE, address(registry));
        entitlement.grantRole(Roles.ORACLE_ROLE, oracle);

        escrow.grantRole(Roles.FACTORY_ROLE, address(factory));
        escrow.grantRole(Roles.ORACLE_ROLE, oracle);

        registry.grantRole(Roles.COMPLIANCE_ROLE, compliance);
        registry.grantRole(Roles.ORACLE_ROLE, oracle);

        receipt.grantRole(Roles.ORACLE_ROLE, oracle);

        factory.registerIssuer(issuer);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _createClass() internal {
        vm.prank(issuer);
        factory.createClass(
            CLASS_ID, TERMS_HASH, address(token), PRICE, OBLIGATION, validUntil, MAX_SUPPLY
        );
    }

    function _fundCollateral(uint256 amount) internal {
        token.mint(issuer, amount);
        vm.startPrank(issuer);
        token.approve(address(escrow), amount);
        escrow.postCollateral(CLASS_ID, amount);
        vm.stopPrank();
    }

    function _buy(address to) internal returns (uint256 tokenId) {
        token.mint(buyer, PRICE);
        vm.startPrank(buyer);
        token.approve(address(escrow), PRICE);
        tokenId = factory.mint(CLASS_ID, to);
        vm.stopPrank();
    }

    /// @notice Class created, collateral posted for the full supply, one bought.
    function _classWithOneEntitlement() internal returns (uint256 tokenId) {
        _createClass();
        _fundCollateral(OBLIGATION * MAX_SUPPLY);
        tokenId = _buy(buyer);
    }

    function _submit(uint256 tokenId, address owner_) internal {
        vm.prank(owner_);
        registry.submitParcel(tokenId, keccak256("parcel"), keccak256("docs"));
    }

    function _decide(uint256 tokenId, Verdict verdict) internal {
        vm.prank(compliance);
        registry.recordDecision(tokenId, keccak256("decision"), "compliance-1.0.0/hs-2026", verdict);
    }

    /// @notice Drive a token all the way to Delivered.
    function _deliver(uint256 tokenId) internal {
        _submit(tokenId, entitlement.ownerOf(tokenId));
        _decide(tokenId, Verdict.Approved);
        vm.startPrank(oracle);
        entitlement.recordLabel(tokenId);
        entitlement.recordPickup(tokenId);
        entitlement.recordDelivery(tokenId);
        vm.stopPrank();
    }

    function _assertState(uint256 tokenId, EntitlementState expected) internal view {
        assertEq(uint8(entitlement.stateOf(tokenId)), uint8(expected), "unexpected entitlement state");
    }
}
