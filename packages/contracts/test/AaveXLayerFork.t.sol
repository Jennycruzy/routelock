// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {AaveYieldAdapter} from "../src/AaveYieldAdapter.sol";
import {IAaveV3AToken, IAaveV3AddressesProvider} from "../src/IAaveV3.sol";
import {SettlementEscrow} from "../src/SettlementEscrow.sol";

/// @notice Mainnet-only rehearsal. It is skipped during the ordinary local
/// suite and enabled explicitly with ROUTELOCK_RUN_XLAYER_FORK=true. The test
/// reads the live Aave reserve and deploys the adapter/escrow only inside the
/// disposable fork; it never broadcasts collateral or changes X Layer.
contract AaveXLayerForkTest is Test {
    address internal constant ASSET = 0x779Ded0c9e1022225f8E0630b35a9b54bE713736;
    address internal constant POOL = 0xE3F3Caefdd7180F884c01E57f65Df979Af84f116;
    address internal constant PROVIDER = 0xdFf435BCcf782f11187D3a4454d96702eD78e092;
    address internal constant ATOKEN = 0xF356ae412dB5df43BD3a10746f7ad4e1C4De4297;

    function setUp() public {
        if (!vm.envOr("ROUTELOCK_RUN_XLAYER_FORK", false)) vm.skip(true);

        string memory rpc = vm.envOr("XLAYER_MAINNET_RPC", string("https://rpc.xlayer.tech"));
        uint256 fork = vm.createFork(rpc);
        vm.selectFork(fork);
    }

    function test_liveXLayerReserveMatchesRouteLockStrategy() public {
        assertEq(block.chainid, 196);
        assertGt(ASSET.code.length, 0);
        assertGt(POOL.code.length, 0);
        assertGt(PROVIDER.code.length, 0);
        assertGt(ATOKEN.code.length, 0);

        assertEq(IAaveV3AddressesProvider(PROVIDER).getPool(), POOL);
        assertEq(IAaveV3AToken(ATOKEN).UNDERLYING_ASSET_ADDRESS(), ASSET);
        assertEq(IERC20Metadata(ASSET).decimals(), 6);
    }

    function test_strategyWiringRehearsesWithoutFunds() public {
        SettlementEscrow escrow = new SettlementEscrow(address(this));
        AaveYieldAdapter adapter = new AaveYieldAdapter(
            address(escrow), POOL, ASSET, ATOKEN
        );
        escrow.setCollateralStrategy(address(adapter));

        assertEq(escrow.collateralStrategy(), address(adapter));
        assertEq(adapter.escrow(), address(escrow));
        assertEq(adapter.asset(), ASSET);
        assertEq(adapter.totalShares(), 0);
        assertEq(adapter.totalAssets(), 0);
    }
}
