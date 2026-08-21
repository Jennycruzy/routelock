// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev The small, stable part of the Aave V3 interfaces used by RouteLock.
/// Keeping this local avoids pulling a second protocol implementation into the
/// escrow build. The signatures match Aave V3's official IPool interfaces.
interface IAaveV3Pool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;

    function withdraw(address asset, uint256 amount, address to) external returns (uint256);

    function getReserveTokensAddresses(address asset)
        external
        view
        returns (address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress);
}

interface IAaveV3AddressesProvider {
    function getPool() external view returns (address);
}

interface IAaveV3AToken {
    function UNDERLYING_ASSET_ADDRESS() external view returns (address);
}
