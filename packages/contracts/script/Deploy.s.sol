// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {ServiceEntitlement} from "../src/ServiceEntitlement.sol";
import {SettlementEscrow} from "../src/SettlementEscrow.sol";
import {AaveYieldAdapter} from "../src/AaveYieldAdapter.sol";
import {IAaveV3AToken, IAaveV3AddressesProvider} from "../src/IAaveV3.sol";
import {EntitlementFactory} from "../src/EntitlementFactory.sol";
import {ActivationRegistry} from "../src/ActivationRegistry.sol";
import {FulfilmentReceipt} from "../src/FulfilmentReceipt.sol";
import {Roles} from "../src/RouteLockTypes.sol";

/// @title Deploy
/// @notice Deploys and wires the five contracts, then proves the wiring before
///         writing anything to `deployments/`.
///
/// The script refuses rather than guesses, in the same way the runtime config
/// does. It will not deploy to a chain it has not verified, will not accept a
/// settlement token it cannot read `decimals()` from, and will not record an
/// address file for a deployment whose role graph does not check out. A missing
/// deployment is recoverable; a deployment whose wiring nobody verified is the
/// thing that gets discovered during a demo.
///
/// Usage:
///
/// ```
/// forge script script/Deploy.s.sol:Deploy \
///   --rpc-url $XLAYER_TESTNET_RPC --broadcast \
///   --private-key $DEPLOYER_KEY
/// ```
///
/// Required environment:
///   ROUTELOCK_ADMIN       address that ends up holding ADMIN_ROLE
///   ROUTELOCK_ISSUER      initial provider address registered on the new factory
///   ROUTELOCK_ORACLE      backend signer; writes carrier-sourced facts
///   ROUTELOCK_COMPLIANCE  compliance service; records decisions, moves no money
contract Deploy is Script {
    error UnverifiedChain(uint256 chainId);
    error MissingEnvironment(string name);
    error SettlementTokenUnreadable(address token);
    error UnexpectedDecimals(address token, uint8 got, uint8 expected);
    error WiringAssertionFailed(string what);
    error RolesNotSeparated(string what, address shared);
    error AaveVenueUnreadable(address target);
    error AavePoolMismatch(address providerPool, address expectedPool);
    error AaveReserveMismatch(address expectedAsset, address liveUnderlying);

    /// @dev Every settlement token below was verified live over RPC on
    ///      2026-08-13 and matches `packages/chain/src/chains.ts`. The address is
    ///      derived from the chain the script is actually running against rather
    ///      than read from the environment, so a typo in a shell variable cannot
    ///      point a deployment at the wrong token.
    struct Target {
        string key;
        address settlementToken;
        string settlementSymbol;
        address aavePool;
        address aaveAddressesProvider;
        address aaveAToken;
    }

    struct Deployment {
        ServiceEntitlement entitlement;
        SettlementEscrow escrow;
        EntitlementFactory factory;
        ActivationRegistry registry;
        FulfilmentReceipt receipt;
        AaveYieldAdapter yieldAdapter;
    }

    string internal constant ENTITLEMENT_NAME = "RouteLock Entitlement";
    string internal constant ENTITLEMENT_SYMBOL = "RLE";

    /// @notice Every target settles in a 6-decimal USD stablecoin, which is why
    ///         pricing arithmetic is identical across all four deployments. A
    ///         token that disagrees invalidates that assumption, so it stops here.
    uint8 internal constant EXPECTED_DECIMALS = 6;

    function run() external {
        Target memory target = _target(block.chainid);

        address admin = _envAddress("ROUTELOCK_ADMIN");
        address issuer = _envAddress("ROUTELOCK_ISSUER");
        address oracle = _envAddress("ROUTELOCK_ORACLE");
        address compliance = _envAddress("ROUTELOCK_COMPLIANCE");

        _assertRoleSeparation(block.chainid, admin, oracle, compliance);
        _assertSettlementToken(target.settlementToken);
        _assertYieldVenue(target);

        address deployer = msg.sender;

        vm.startBroadcast();
        Deployment memory d = _deployAndWire(
            deployer,
            oracle,
            compliance,
            target.settlementToken,
            target.aavePool,
            target.aaveAToken
        );
        d.factory.registerIssuer(issuer);
        if (admin != deployer) {
            _handOverAdmin(d, deployer, admin);
        }
        vm.stopBroadcast();

        _assertWiring(d, admin, oracle, compliance);
        _require(d.factory.isRegisteredIssuer(issuer), "factory.issuer");
        _write(d, target, admin, issuer, oracle, compliance);
    }

    // ---------------------------------------------------------------------
    // Deployment
    // ---------------------------------------------------------------------

    /// @dev Deploys with `admin` holding ADMIN_ROLE, because the wiring calls
    ///      below are themselves admin-gated. This mirrors `RouteLockBase.setUp`
    ///      exactly — if the two drift, a role that is wrong in production is
    ///      wrong in the tests too, which is the point.
    function _deployAndWire(address admin, address oracle, address compliance)
        internal
        returns (Deployment memory d)
    {
        return _deployAndWire(admin, oracle, compliance, address(0), address(0), address(0));
    }

    /// @dev The mainnet X Layer target passes its verified Aave reserve here.
    /// Testnet and BOT targets pass zeroes and retain the raw-collateral path.
    function _deployAndWire(
        address admin,
        address oracle,
        address compliance,
        address settlementToken,
        address aavePool,
        address aaveAToken
    ) internal returns (Deployment memory d) {
        d.entitlement = new ServiceEntitlement(ENTITLEMENT_NAME, ENTITLEMENT_SYMBOL, admin);
        d.escrow = new SettlementEscrow(admin);
        d.factory = new EntitlementFactory(admin, address(d.entitlement), address(d.escrow));
        d.registry = new ActivationRegistry(admin, address(d.entitlement));
        d.receipt = new FulfilmentReceipt(admin);

        d.entitlement.setClasses(address(d.factory));
        d.entitlement.grantRole(Roles.FACTORY_ROLE, address(d.factory));
        d.entitlement.grantRole(Roles.REGISTRY_ROLE, address(d.registry));
        d.entitlement.grantRole(Roles.ORACLE_ROLE, oracle);

        d.escrow.grantRole(Roles.FACTORY_ROLE, address(d.factory));
        d.escrow.grantRole(Roles.ORACLE_ROLE, oracle);

        d.registry.grantRole(Roles.COMPLIANCE_ROLE, compliance);
        d.registry.grantRole(Roles.ORACLE_ROLE, oracle);

        d.receipt.grantRole(Roles.ORACLE_ROLE, oracle);

        if (aavePool != address(0)) {
            d.yieldAdapter = new AaveYieldAdapter(
                address(d.escrow), aavePool, settlementToken, aaveAToken
            );
            d.escrow.setCollateralStrategy(address(d.yieldAdapter));
        }
    }

    /// @dev Move admin off the deployer key. The deployer renounces last, so a
    ///      failure part-way leaves the contracts administrable rather than
    ///      orphaned.
    function _handOverAdmin(Deployment memory d, address deployer, address admin) internal {
        _grantAdmin(d.entitlement, admin);
        _grantAdmin(d.escrow, admin);
        _grantAdmin(d.factory, admin);
        _grantAdmin(d.registry, admin);
        _grantAdmin(d.receipt, admin);

        _renounceAdmin(d.entitlement, deployer);
        _renounceAdmin(d.escrow, deployer);
        _renounceAdmin(d.factory, deployer);
        _renounceAdmin(d.registry, deployer);
        _renounceAdmin(d.receipt, deployer);
    }

    function _grantAdmin(IAccessControl target, address admin) private {
        target.grantRole(0x00, admin); // DEFAULT_ADMIN_ROLE
        target.grantRole(Roles.ADMIN_ROLE, admin);
    }

    function _renounceAdmin(IAccessControl target, address deployer) private {
        target.renounceRole(Roles.ADMIN_ROLE, deployer);
        target.renounceRole(0x00, deployer);
    }

    // ---------------------------------------------------------------------
    // Verification — runs before anything is recorded
    // ---------------------------------------------------------------------

    /// @notice Read the settlement token before trusting it.
    ///
    /// An address that does not answer `decimals()` is not an ERC-20, and an
    /// answer other than 6 breaks the pricing arithmetic every contract assumes.
    function _assertSettlementToken(address token) internal view {
        // Checked explicitly: a high-level call to an address with no code
        // reverts without data, which try/catch cannot turn into a named error.
        // Without this the operator sees a bare revert instead of being told
        // that the settlement address is not a contract.
        if (token.code.length == 0) revert SettlementTokenUnreadable(token);

        try IERC20Metadata(token).decimals() returns (uint8 decimals) {
            if (decimals != EXPECTED_DECIMALS) {
                revert UnexpectedDecimals(token, decimals, EXPECTED_DECIMALS);
            }
        } catch {
            revert SettlementTokenUnreadable(token);
        }
    }

    /// @notice Refuse a deployment whose roles collapse into one key.
    ///
    /// Runs **before** `startBroadcast`. `_assertWiring` would already catch the
    /// compliance collision, but only after the contracts are deployed and the
    /// gas is spent — which leaves an operator holding a half-built deployment
    /// and a revert to interpret. A precondition belongs before the money.
    ///
    /// Three separations, and they are not equally severe:
    ///
    /// **`oracle != compliance` — every chain, no exception.** `ORACLE_ROLE`
    /// holds `releaseToIssuer` and `refundBuyer`. Pointing compliance at that
    /// key hands the model's signer the ability to move escrowed funds, which
    /// erases the one guarantee the whole design is built to make structural.
    /// `SettlementEscrow` refusing to grant `COMPLIANCE_ROLE` protects against
    /// granting the wrong role; it cannot protect against reusing the address.
    ///
    /// **`admin != oracle` — mainnet only.** The oracle signs unattended from a
    /// server, so its key lives where a compromise can reach it. Sharing it with
    /// `ADMIN_ROLE` means that same compromise can also grant roles, revoke
    /// them, and re-point the contracts. On a testnet whose funds are faucet
    /// tokens that is an accepted shortcut. On mainnet it is not, so it is
    /// enforced here rather than left to a line in a handoff document that
    /// somebody has to remember at the wrong hour.
    ///
    /// **`admin != compliance` — every chain.** Same reasoning as the first,
    /// arrived at from the other side.
    function _assertRoleSeparation(
        uint256 chainId,
        address admin,
        address oracle,
        address compliance
    ) internal pure {
        if (oracle == compliance) revert RolesNotSeparated("oracle==compliance", oracle);
        if (admin == compliance) revert RolesNotSeparated("admin==compliance", admin);

        if (admin == oracle && _isMainnet(chainId)) {
            revert RolesNotSeparated("admin==oracle on mainnet", admin);
        }
    }

    /// @dev The two mainnets, named rather than inferred. A chain absent from
    ///      `_target` never reaches this function, so an unknown id defaulting
    ///      to "testnet" here cannot weaken anything.
    function _isMainnet(uint256 chainId) internal pure returns (bool) {
        return chainId == 196 || chainId == 677;
    }

    /// @notice Prove the role graph, including the negative half.
    ///
    /// The assertions that matter most are the ones that must be *false*: the
    /// compliance service holds nothing on the escrow, and cannot be given
    /// anything there. A deployment that silently lost that property would look
    /// identical from the outside until the moment it mattered.
    function _assertWiring(Deployment memory d, address admin, address oracle, address compliance)
        internal
    {
        _require(address(d.entitlement.classes()) == address(d.factory), "entitlement.classes");
        _require(d.entitlement.hasRole(Roles.FACTORY_ROLE, address(d.factory)), "entitlement.factory");
        _require(d.entitlement.hasRole(Roles.REGISTRY_ROLE, address(d.registry)), "entitlement.registry");
        _require(d.entitlement.hasRole(Roles.ORACLE_ROLE, oracle), "entitlement.oracle");
        _require(d.escrow.hasRole(Roles.FACTORY_ROLE, address(d.factory)), "escrow.factory");
        _require(d.escrow.hasRole(Roles.ORACLE_ROLE, oracle), "escrow.oracle");
        _require(d.registry.hasRole(Roles.COMPLIANCE_ROLE, compliance), "registry.compliance");
        _require(d.registry.hasRole(Roles.ORACLE_ROLE, oracle), "registry.oracle");
        _require(d.receipt.hasRole(Roles.ORACLE_ROLE, oracle), "receipt.oracle");

        if (address(d.yieldAdapter) != address(0)) {
            _require(
                d.escrow.collateralStrategy() == address(d.yieldAdapter),
                "escrow.yieldAdapter"
            );
            _require(d.yieldAdapter.escrow() == address(d.escrow), "yieldAdapter.escrow");
            _require(d.yieldAdapter.asset() != address(0), "yieldAdapter.asset");
        }

        _require(address(d.factory.entitlement()) == address(d.entitlement), "factory.entitlement");
        _require(address(d.factory.escrow()) == address(d.escrow), "factory.escrow");
        _require(address(d.registry.entitlement()) == address(d.entitlement), "registry.entitlement");

        // Admin landed where it was meant to.
        _require(d.entitlement.hasRole(Roles.ADMIN_ROLE, admin), "entitlement.admin");
        _require(d.escrow.hasRole(Roles.ADMIN_ROLE, admin), "escrow.admin");
        _require(d.factory.hasRole(Roles.ADMIN_ROLE, admin), "factory.admin");
        _require(d.registry.hasRole(Roles.ADMIN_ROLE, admin), "registry.admin");
        _require(d.receipt.hasRole(Roles.ADMIN_ROLE, admin), "receipt.admin");

        // The AI holds no authority over money, and none can be conferred.
        _require(!d.escrow.hasRole(Roles.COMPLIANCE_ROLE, compliance), "escrow.compliance.absent");
        _require(!d.escrow.hasRole(Roles.ORACLE_ROLE, compliance), "escrow.compliance.oracle");
        _require(!d.escrow.hasRole(Roles.FACTORY_ROLE, compliance), "escrow.compliance.factory");
        _require(!d.entitlement.hasRole(Roles.REGISTRY_ROLE, compliance), "entitlement.compliance");

        vm.prank(admin);
        try d.escrow.grantRole(Roles.COMPLIANCE_ROLE, compliance) {
            revert WiringAssertionFailed("escrow accepted COMPLIANCE_ROLE");
        } catch {
            // Expected: SettlementEscrow._grantRole rejects the role outright.
        }
    }

    function _require(bool ok, string memory what) private pure {
        if (!ok) revert WiringAssertionFailed(what);
    }

    // ---------------------------------------------------------------------
    // Address file
    // ---------------------------------------------------------------------

    /// @notice Record the addresses — but only when they are real.
    ///
    /// A dry run produces the same addresses a broadcast would, at contracts
    /// that do not exist. Writing them would leave a file in `deployments/`
    /// indistinguishable from a real deployment, which is precisely the kind of
    /// plausible-looking artefact the build rules forbid. Simulations therefore
    /// verify everything and record nothing.
    function _write(
        Deployment memory d,
        Target memory target,
        address admin,
        address issuer,
        address oracle,
        address compliance
    ) internal {
        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            console2.log("Dry run: verification passed, no address file written.");
            console2.log("Re-run with --broadcast to deploy and record addresses.");
            return;
        }

        string memory obj = "deployment";

        vm.serializeString(obj, "chain", target.key);
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeUint(obj, "deployedAtBlock", block.number);
        vm.serializeUint(obj, "deployedAt", block.timestamp);
        vm.serializeAddress(obj, "settlementToken", target.settlementToken);
        vm.serializeString(obj, "settlementSymbol", target.settlementSymbol);
        vm.serializeAddress(obj, "admin", admin);
        vm.serializeAddress(obj, "issuer", issuer);
        vm.serializeBool(obj, "permissionlessIssuers", true);
        vm.serializeAddress(obj, "oracle", oracle);
        vm.serializeAddress(obj, "compliance", compliance);
        vm.serializeAddress(obj, "serviceEntitlement", address(d.entitlement));
        vm.serializeAddress(obj, "settlementEscrow", address(d.escrow));
        vm.serializeAddress(obj, "entitlementFactory", address(d.factory));
        vm.serializeAddress(obj, "activationRegistry", address(d.registry));
        vm.serializeAddress(obj, "aaveYieldAdapter", address(d.yieldAdapter));
        string memory json = vm.serializeAddress(obj, "fulfilmentReceipt", address(d.receipt));

        vm.writeJson(json, string.concat("../../deployments/", target.key, ".json"));
    }

    /// @notice Confirm the venue and the specific reserve before any new
    /// escrow is deployed. Aave being present is not enough: the provider,
    /// pool and aToken must all agree on RouteLock's settlement asset.
    function _assertYieldVenue(Target memory target) internal view {
        if (target.aavePool == address(0)) return;

        if (target.aaveAddressesProvider.code.length == 0) {
            revert AaveVenueUnreadable(target.aaveAddressesProvider);
        }
        if (target.aavePool.code.length == 0) revert AaveVenueUnreadable(target.aavePool);
        if (target.aaveAToken.code.length == 0) revert AaveVenueUnreadable(target.aaveAToken);

        address livePool;
        try IAaveV3AddressesProvider(target.aaveAddressesProvider).getPool() returns (address pool) {
            livePool = pool;
        } catch {
            revert AaveVenueUnreadable(target.aaveAddressesProvider);
        }
        if (livePool != target.aavePool) revert AavePoolMismatch(livePool, target.aavePool);

        address underlying;
        try IAaveV3AToken(target.aaveAToken).UNDERLYING_ASSET_ADDRESS() returns (address asset) {
            underlying = asset;
        } catch {
            revert AaveVenueUnreadable(target.aaveAToken);
        }
        if (underlying != target.settlementToken) {
            revert AaveReserveMismatch(target.settlementToken, underlying);
        }
    }

    // ---------------------------------------------------------------------
    // Targets
    // ---------------------------------------------------------------------

    /// @dev Unknown chain ids revert. Note that X Layer testnet is **1952**, not
    ///      the 195 that stale directories still publish — deploying against a
    ///      chain id nobody verified is exactly the mistake this rejects.
    function _target(uint256 chainId) internal pure returns (Target memory) {
        if (chainId == 1952) {
            return Target({
                key: "xlayer_testnet",
                settlementToken: 0x9e29b3AaDa05Bf2D2c827Af80Bd28Dc0b9b4FB0c,
                settlementSymbol: unicode"USD₮0",
                aavePool: address(0),
                aaveAddressesProvider: address(0),
                aaveAToken: address(0)
            });
        }
        if (chainId == 196) {
            // USD₮0, the canonical stablecoin on X Layer. Corrected 2026-08-17
            // from 0x1E4a5963… ("Tether USD"), the legacy bridged token being
            // phased out: 30x less supply, 19x less transfer activity, and
            // absent from Aave's X Layer reserve list. Both answer decimals()
            // with 6, so `_assertSettlementToken` accepted either — the check
            // proves a token is a 6-decimal ERC-20, never that it is the right
            // one. See packages/chain/src/chains.ts.
            return Target({
                key: "xlayer_mainnet",
                settlementToken: 0x779Ded0c9e1022225f8E0630b35a9b54bE713736,
                settlementSymbol: unicode"USD₮0",
                aavePool: 0xE3F3Caefdd7180F884c01E57f65Df979Af84f116,
                aaveAddressesProvider: 0xdFf435BCcf782f11187D3a4454d96702eD78e092,
                aaveAToken: 0xF356ae412dB5df43BD3a10746f7ad4e1C4De4297
            });
        }
        if (chainId == 968) {
            return Target({
                key: "botchain_testnet",
                settlementToken: 0x75edC9335175Fc0552D51D48439F229c10420fe3,
                settlementSymbol: "USDT",
                aavePool: address(0),
                aaveAddressesProvider: address(0),
                aaveAToken: address(0)
            });
        }
        if (chainId == 677) {
            return Target({
                key: "botchain_mainnet",
                settlementToken: 0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C,
                settlementSymbol: "USDT",
                aavePool: address(0),
                aaveAddressesProvider: address(0),
                aaveAToken: address(0)
            });
        }
        revert UnverifiedChain(chainId);
    }

    function _envAddress(string memory name) internal view returns (address value) {
        try vm.envAddress(name) returns (address v) {
            value = v;
        } catch {
            revert MissingEnvironment(name);
        }
        if (value == address(0)) revert MissingEnvironment(name);
    }
}
