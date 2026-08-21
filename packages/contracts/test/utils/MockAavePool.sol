// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {TestERC20} from "./TestERC20.sol";
import {IAaveV3Pool} from "../../src/IAaveV3.sol";

/// @notice A deliberately small Aave-shaped reserve for unit and invariant
/// tests. It models aToken appreciation by minting aTokens and matching
/// underlying liquidity into the pool.
contract MockAToken is ERC20 {
    address public immutable underlying;

    constructor(address underlying_) ERC20("Mock Aave USD", "maUSD") {
        underlying = underlying_;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }

    function UNDERLYING_ASSET_ADDRESS() external view returns (address) {
        return underlying;
    }
}

contract MockAavePool is IAaveV3Pool {
    IERC20 public immutable underlying;
    MockAToken public immutable reserveAToken;
    bool public withdrawalsEnabled = true;

    constructor(address underlying_) {
        underlying = IERC20(underlying_);
        reserveAToken = new MockAToken(underlying_);
    }

    function supply(address asset, uint256 amount, address onBehalfOf, uint16)
        external
        override
    {
        require(asset == address(underlying), "wrong asset");
        require(underlying.transferFrom(msg.sender, address(this), amount), "transfer in failed");
        reserveAToken.mint(onBehalfOf, amount);
    }

    function withdraw(address asset, uint256 amount, address to)
        external
        override
        returns (uint256)
    {
        require(withdrawalsEnabled, "withdrawals disabled");
        require(asset == address(underlying), "wrong asset");
        uint256 actual = amount == type(uint256).max ? reserveAToken.balanceOf(msg.sender) : amount;
        reserveAToken.burn(msg.sender, actual);
        require(underlying.transfer(to, actual), "transfer out failed");
        return actual;
    }

    function getReserveTokensAddresses(address asset)
        external
        view
        override
        returns (address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress)
    {
        require(asset == address(underlying), "wrong asset");
        return (address(reserveAToken), address(0), address(0));
    }

    function addYield(address beneficiary, uint256 amount) external {
        TestERC20(address(underlying)).mint(address(this), amount);
        reserveAToken.mint(beneficiary, amount);
    }

    function setWithdrawalsEnabled(bool enabled) external {
        withdrawalsEnabled = enabled;
    }
}
