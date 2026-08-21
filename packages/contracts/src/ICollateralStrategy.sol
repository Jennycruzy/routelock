// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Minimal interface the escrow needs from an idle-collateral venue.
///
/// The escrow owns the strategy position. Individual classes own shares in that
/// position, so several offers can use one Aave reserve without one class
/// diluting another when interest accrues.
interface ICollateralStrategy {
    function escrow() external view returns (address);
    function asset() external view returns (address);
    function totalAssets() external view returns (uint256);
    function totalShares() external view returns (uint256);
    function previewDeposit(uint256 assets) external view returns (uint256 shares);
    function previewRedeem(uint256 shares) external view returns (uint256 assets);
    function previewWithdraw(uint256 assets) external view returns (uint256 shares);
    function deposit(uint256 assets) external returns (uint256 shares);
    function redeem(uint256 shares) external returns (uint256 assets);
}
