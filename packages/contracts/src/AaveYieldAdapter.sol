// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IAaveV3AToken, IAaveV3Pool} from "./IAaveV3.sol";
import {ICollateralStrategy} from "./ICollateralStrategy.sol";

/// @title AaveYieldAdapter
/// @notice Supplies idle RouteLock collateral to one verified Aave V3 reserve.
///
/// The adapter is deliberately not a general-purpose vault. Only its escrow
/// can deposit or redeem, and it never accepts a second asset or a second
/// caller. The escrow keeps the per-class share ledger; this contract keeps the
/// aggregate Aave position and converts shares to the underlying conservatively.
/// Interest therefore increases the value of the class that supplied the idle
/// collateral, while the escrow's outstanding-obligation check remains the
/// final authority before any withdrawal or new mint.
contract AaveYieldAdapter is ICollateralStrategy, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error ZeroAddress();
    error ZeroAmount();
    error OnlyEscrow(address caller);
    error ZeroShares();
    error AccountingInvariant();
    error TooManyShares(uint256 requested, uint256 available);
    error WithdrawalMismatch(uint256 requested, uint256 received);
    error ReserveAssetMismatch(address expected, address actual);

    event Deposited(uint256 assets, uint256 shares, uint256 totalAssets, uint256 totalShares);
    event Redeemed(uint256 shares, uint256 assets, uint256 totalAssets, uint256 totalShares);

    address public immutable override escrow;
    address public immutable override asset;
    IAaveV3Pool public immutable pool;
    address public immutable aToken;

    uint256 public override totalShares;

    constructor(address escrow_, address pool_, address asset_, address aToken_) {
        if (escrow_ == address(0) || pool_ == address(0) || asset_ == address(0) || aToken_ == address(0)) {
            revert ZeroAddress();
        }
        escrow = escrow_;
        pool = IAaveV3Pool(pool_);
        asset = asset_;
        aToken = aToken_;

        try IAaveV3AToken(aToken_).UNDERLYING_ASSET_ADDRESS() returns (address underlying) {
            if (underlying != asset_) revert ReserveAssetMismatch(asset_, underlying);
        } catch {
            revert ReserveAssetMismatch(asset_, address(0));
        }
    }

    modifier onlyEscrow() {
        if (msg.sender != escrow) revert OnlyEscrow(msg.sender);
        _;
    }

    /// @notice Aave's aToken balance is the underlying value including accrued
    /// interest. Aave's pool itself remains the source of truth for withdrawal.
    function totalAssets() public view override returns (uint256) {
        return IERC20(aToken).balanceOf(address(this));
    }

    function previewDeposit(uint256 assets) public view override returns (uint256 shares) {
        if (assets == 0) return 0;
        uint256 sharesSupply = totalShares;
        if (sharesSupply == 0) return assets;

        uint256 assetsSupply = totalAssets();
        if (assetsSupply == 0) revert AccountingInvariant();
        shares = assets * sharesSupply / assetsSupply;
    }

    function previewRedeem(uint256 shares) public view override returns (uint256 assets) {
        if (shares == 0) return 0;
        if (shares > totalShares) revert TooManyShares(shares, totalShares);

        uint256 assetsSupply = totalAssets();
        if (assetsSupply == 0) return 0;
        assets = shares * assetsSupply / totalShares;
    }

    /// @dev Round up: a caller asking for X assets must burn enough shares to
    /// receive at least X, subject to the pool returning the requested amount.
    function previewWithdraw(uint256 assets) public view override returns (uint256 shares) {
        if (assets == 0) return 0;
        uint256 assetsSupply = totalAssets();
        if (assetsSupply == 0 || totalShares == 0) revert AccountingInvariant();
        shares = (assets * totalShares + assetsSupply - 1) / assetsSupply;
    }

    function deposit(uint256 assets)
        external
        override
        onlyEscrow
        nonReentrant
        returns (uint256 shares)
    {
        if (assets == 0) revert ZeroAmount();

        shares = previewDeposit(assets);
        if (shares == 0) revert ZeroShares();

        totalShares += shares;
        IERC20(asset).safeTransferFrom(msg.sender, address(this), assets);
        IERC20(asset).forceApprove(address(pool), assets);
        pool.supply(asset, assets, address(this), 0);

        emit Deposited(assets, shares, totalAssets(), totalShares);
    }

    function redeem(uint256 shares)
        external
        override
        onlyEscrow
        nonReentrant
        returns (uint256 assets)
    {
        if (shares == 0) revert ZeroAmount();
        if (shares > totalShares) revert TooManyShares(shares, totalShares);

        assets = previewRedeem(shares);
        if (assets == 0) revert AccountingInvariant();

        totalShares -= shares;
        uint256 received = pool.withdraw(asset, assets, escrow);
        if (received < assets) revert WithdrawalMismatch(assets, received);

        emit Redeemed(shares, received, totalAssets(), totalShares);
        return received;
    }
}
