// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {Deploy} from "../script/Deploy.s.sol";
import {ServiceEntitlement} from "../src/ServiceEntitlement.sol";
import {SettlementEscrow} from "../src/SettlementEscrow.sol";
import {EntitlementFactory} from "../src/EntitlementFactory.sol";
import {ActivationRegistry, Verdict} from "../src/ActivationRegistry.sol";
import {FulfilmentReceipt} from "../src/FulfilmentReceipt.sol";
import {Roles, EntitlementState} from "../src/RouteLockTypes.sol";
import {TestERC20} from "./utils/TestERC20.sol";

/// @notice Exposes the script's internals so the deployment path is exercised
///         by `forge test` rather than first tried against a real chain.
///
/// The harness itself is the initial admin, which is what the script arranges
/// too: the wiring calls are admin-gated, so the account performing them has to
/// hold ADMIN_ROLE while it performs them.
contract DeployHarness is Deploy {
    Deployment internal dep;

    function deployAndWire(address oracle, address compliance) external {
        dep = _deployAndWire(address(this), oracle, compliance);
    }

    function handOverAdmin(address admin) external {
        _handOverAdmin(dep, address(this), admin);
    }

    function assertWiring(address admin, address oracle, address compliance) external {
        _assertWiring(dep, admin, oracle, compliance);
    }

    function targetFor(uint256 chainId) external pure returns (Target memory) {
        return _target(chainId);
    }

    function checkRoleSeparation(
        uint256 chainId,
        address admin,
        address oracle,
        address compliance
    ) external pure {
        _assertRoleSeparation(chainId, admin, oracle, compliance);
    }

    function checkSettlementToken(address token) external view {
        _assertSettlementToken(token);
    }

    function deployment() external view returns (Deployment memory) {
        return dep;
    }
}

/// @notice A token that answers `decimals()` with something other than 6.
contract EighteenDecimalToken {
    function decimals() external pure returns (uint8) {
        return 18;
    }
}

contract DeployTest is Test {
    DeployHarness internal harness;

    address internal admin = makeAddr("admin");
    address internal oracle = makeAddr("oracle");
    address internal compliance = makeAddr("compliance");
    address internal issuer = makeAddr("issuer");
    address internal buyer = makeAddr("buyer");

    function setUp() public {
        harness = new DeployHarness();
    }

    // ---------------------------------------------------------------------
    // Wiring
    // ---------------------------------------------------------------------

    function test_wiringPassesItsOwnAssertions() public {
        harness.deployAndWire(oracle, compliance);
        harness.assertWiring(address(harness), oracle, compliance);
    }

    // ---------------------------------------------------------------------
    // Role separation, checked before anything is broadcast
    // ---------------------------------------------------------------------

    function test_separatedRolesPassOnEveryChain() public view {
        uint256[4] memory chains = [uint256(1952), 196, 968, 677];
        for (uint256 i = 0; i < chains.length; i++) {
            harness.checkRoleSeparation(chains[i], admin, oracle, compliance);
        }
    }

    /// The severe one. `ORACLE_ROLE` can call `releaseToIssuer` and
    /// `refundBuyer`, so an oracle that is also the compliance signer hands the
    /// model's key the ability to move escrowed money — the exact thing the
    /// escrow's `COMPLIANCE_ROLE` refusal exists to make impossible. Refusing to
    /// grant a role cannot defend against reusing an address, so this must.
    function test_complianceSharingTheOracleKeyIsRefusedOnEveryChain() public {
        uint256[4] memory chains = [uint256(1952), 196, 968, 677];
        for (uint256 i = 0; i < chains.length; i++) {
            vm.expectRevert(
                abi.encodeWithSelector(Deploy.RolesNotSeparated.selector, "oracle==compliance", oracle)
            );
            harness.checkRoleSeparation(chains[i], admin, oracle, oracle);
        }
    }

    function test_adminSharingTheComplianceKeyIsRefusedOnEveryChain() public {
        uint256[4] memory chains = [uint256(1952), 196, 968, 677];
        for (uint256 i = 0; i < chains.length; i++) {
            vm.expectRevert(
                abi.encodeWithSelector(Deploy.RolesNotSeparated.selector, "admin==compliance", admin)
            );
            harness.checkRoleSeparation(chains[i], admin, oracle, admin);
        }
    }

    /// The testnet shortcut this project actually took, and is allowed to keep.
    function test_adminMayShareTheOracleKeyOnTestnet() public view {
        harness.checkRoleSeparation(1952, admin, admin, compliance);
        harness.checkRoleSeparation(968, admin, admin, compliance);
    }

    /// ...and may not carry it to mainnet. The oracle signs unattended from a
    /// server, so sharing its key with ADMIN_ROLE means a box compromise reaches
    /// role administration too.
    function test_adminSharingTheOracleKeyIsRefusedOnMainnet() public {
        vm.expectRevert(
            abi.encodeWithSelector(Deploy.RolesNotSeparated.selector, "admin==oracle on mainnet", admin)
        );
        harness.checkRoleSeparation(196, admin, admin, compliance);

        vm.expectRevert(
            abi.encodeWithSelector(Deploy.RolesNotSeparated.selector, "admin==oracle on mainnet", admin)
        );
        harness.checkRoleSeparation(677, admin, admin, compliance);
    }

    function test_adminHandoverLeavesTheDeployerWithNothing() public {
        harness.deployAndWire(oracle, compliance);
        harness.handOverAdmin(admin);
        harness.assertWiring(admin, oracle, compliance);

        Deploy.Deployment memory d = harness.deployment();
        address deployer = address(harness);

        assertFalse(d.entitlement.hasRole(Roles.ADMIN_ROLE, deployer), "deployer kept entitlement admin");
        assertFalse(d.escrow.hasRole(Roles.ADMIN_ROLE, deployer), "deployer kept escrow admin");
        assertFalse(d.factory.hasRole(Roles.ADMIN_ROLE, deployer), "deployer kept factory admin");
        assertFalse(d.registry.hasRole(Roles.ADMIN_ROLE, deployer), "deployer kept registry admin");
        assertFalse(d.receipt.hasRole(Roles.ADMIN_ROLE, deployer), "deployer kept receipt admin");

        assertFalse(d.escrow.hasRole(0x00, deployer), "deployer kept escrow default admin");
        assertTrue(d.escrow.hasRole(0x00, admin), "admin did not receive default admin");
    }

    /// @notice The assertion suite must actually fail when the wiring is wrong.
    ///
    /// Without this, `_assertWiring` passing proves only that it was called.
    function test_wiringAssertionCatchesAMissingRole() public {
        harness.deployAndWire(oracle, compliance);
        Deploy.Deployment memory d = harness.deployment();

        vm.prank(address(harness));
        d.registry.revokeRole(Roles.COMPLIANCE_ROLE, compliance);

        vm.expectRevert(
            abi.encodeWithSelector(Deploy.WiringAssertionFailed.selector, "registry.compliance")
        );
        harness.assertWiring(address(harness), oracle, compliance);
    }

    function test_wiringAssertionCatchesAnUnexpectedRole() public {
        harness.deployAndWire(oracle, compliance);
        Deploy.Deployment memory d = harness.deployment();

        // Compliance must hold nothing on the escrow — not even the oracle role,
        // which is the one that actually releases money.
        vm.prank(address(harness));
        d.escrow.grantRole(Roles.ORACLE_ROLE, compliance);

        vm.expectRevert(
            abi.encodeWithSelector(
                Deploy.WiringAssertionFailed.selector, "escrow.compliance.oracle"
            )
        );
        harness.assertWiring(address(harness), oracle, compliance);
    }

    /// @notice A freshly deployed system must work end to end, not merely hold
    ///         the right roles. Buy, submit, refuse, resubmit, approve, deliver.
    function test_deployedSystemCompletesTheLifecycle() public {
        harness.deployAndWire(oracle, compliance);
        harness.handOverAdmin(admin);
        Deploy.Deployment memory d = harness.deployment();

        TestERC20 token = new TestERC20();
        bytes32 classId = keccak256("PHC-LOS-1KG-STD");
        uint256 price = 12_000_000;
        uint256 obligation = 20_000_000;

        vm.prank(admin);
        d.factory.registerIssuer(issuer);

        vm.prank(issuer);
        d.factory.createClass(
            classId,
            keccak256("terms-v1"),
            address(token),
            price,
            obligation,
            uint64(block.timestamp + 30 days),
            10
        );

        token.mint(issuer, obligation);
        vm.startPrank(issuer);
        token.approve(address(d.escrow), obligation);
        d.escrow.postCollateral(classId, obligation);
        vm.stopPrank();

        token.mint(buyer, price);
        vm.startPrank(buyer);
        token.approve(address(d.escrow), price);
        uint256 tokenId = d.factory.mint(classId, buyer);
        vm.stopPrank();

        // Refusal first: it must be a working path on a fresh deployment.
        vm.prank(buyer);
        d.registry.submitParcel(tokenId, keccak256("parcel"), keccak256("docs"));
        vm.prank(compliance);
        d.registry.recordDecision(tokenId, keccak256("refusal"), "compliance-1.0.0", Verdict.Refused);
        assertEq(uint8(d.entitlement.stateOf(tokenId)), uint8(EntitlementState.Available));
        assertEq(token.balanceOf(address(d.escrow)), obligation + price, "refusal moved money");

        // Corrected and approved.
        vm.prank(buyer);
        d.registry.submitParcel(tokenId, keccak256("parcel-v2"), keccak256("docs"));
        vm.prank(compliance);
        d.registry.recordDecision(tokenId, keccak256("approval"), "compliance-1.0.0", Verdict.Approved);
        assertEq(uint8(d.entitlement.stateOf(tokenId)), uint8(EntitlementState.Activated));

        vm.startPrank(oracle);
        d.entitlement.recordLabel(tokenId);
        d.escrow.releaseToIssuer(tokenId);
        d.entitlement.recordPickup(tokenId);
        d.entitlement.recordDelivery(tokenId);
        d.receipt.mintReceipt(tokenId, classId, issuer, uint64(block.timestamp));
        d.registry.publishTracking(tokenId, "SB-TRACK-001");
        vm.stopPrank();

        assertEq(uint8(d.entitlement.stateOf(tokenId)), uint8(EntitlementState.Delivered));
        assertEq(d.receipt.ownerOf(1), issuer);

        vm.prank(issuer);
        d.escrow.claim(address(token));
        assertEq(token.balanceOf(issuer), price, "issuer not paid on a fresh deployment");
    }

    // ---------------------------------------------------------------------
    // Targets
    // ---------------------------------------------------------------------

    function test_knownChainsResolveToTheirVerifiedTokens() public view {
        Deploy.Target memory xlayerTest = harness.targetFor(1952);
        assertEq(xlayerTest.key, "xlayer_testnet");
        assertEq(xlayerTest.settlementToken, 0x9e29b3AaDa05Bf2D2c827Af80Bd28Dc0b9b4FB0c);

        assertEq(harness.targetFor(196).settlementToken, 0x1E4a5963aBFD975d8c9021ce480b42188849D41d);
        assertEq(harness.targetFor(968).settlementToken, 0x75edC9335175Fc0552D51D48439F229c10420fe3);
        assertEq(harness.targetFor(677).settlementToken, 0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C);

        assertEq(harness.targetFor(968).key, "botchain_testnet");
        assertEq(harness.targetFor(677).key, "botchain_mainnet");
    }

    /// @notice 195 is the stale X Layer testnet id that directories still
    ///         publish. It must not resolve, or a deploy aimed at testnet lands
    ///         somewhere nobody verified.
    function test_staleXLayerTestnetIdIsRejected() public {
        vm.expectRevert(abi.encodeWithSelector(Deploy.UnverifiedChain.selector, 195));
        harness.targetFor(195);
    }

    function test_unknownChainIsRejected() public {
        vm.expectRevert(abi.encodeWithSelector(Deploy.UnverifiedChain.selector, 31337));
        harness.targetFor(31337);

        vm.expectRevert(abi.encodeWithSelector(Deploy.UnverifiedChain.selector, 1));
        harness.targetFor(1);
    }

    /// @notice Every target must pair a testnet key with a testnet token; the
    ///         mainnet tokens must never appear under a testnet chain id.
    function test_noTokenIsSharedBetweenTargets() public view {
        uint256[4] memory ids = [uint256(1952), 196, 968, 677];
        for (uint256 i = 0; i < ids.length; i++) {
            for (uint256 j = i + 1; j < ids.length; j++) {
                assertTrue(
                    harness.targetFor(ids[i]).settlementToken
                        != harness.targetFor(ids[j]).settlementToken,
                    "two chains share a settlement token address"
                );
            }
        }
    }

    // ---------------------------------------------------------------------
    // Settlement token verification
    // ---------------------------------------------------------------------

    function test_sixDecimalTokenAccepted() public {
        TestERC20 token = new TestERC20();
        harness.checkSettlementToken(address(token));
    }

    function test_wrongDecimalsRejected() public {
        EighteenDecimalToken token = new EighteenDecimalToken();
        vm.expectRevert(
            abi.encodeWithSelector(Deploy.UnexpectedDecimals.selector, address(token), 18, 6)
        );
        harness.checkSettlementToken(address(token));
    }

    /// @notice An address with no code answers nothing. Deploying against it
    ///         would produce a system whose transfers silently do nothing.
    function test_addressWithoutCodeRejected() public {
        address notAToken = makeAddr("not-a-token");
        vm.expectRevert(
            abi.encodeWithSelector(Deploy.SettlementTokenUnreadable.selector, notAToken)
        );
        harness.checkSettlementToken(notAToken);
    }

    function test_nonTokenContractRejected() public {
        vm.expectRevert(
            abi.encodeWithSelector(Deploy.SettlementTokenUnreadable.selector, address(harness))
        );
        harness.checkSettlementToken(address(harness));
    }
}
