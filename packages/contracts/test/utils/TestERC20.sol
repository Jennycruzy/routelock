// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test-only settlement token, 6 decimals to mirror USDT/USD₮0 on every
///         target chain. Lives under `test/` and is never deployed by any
///         script — production settlement always points at a real token address
///         verified against the live chain.
contract TestERC20 is ERC20 {
    constructor() ERC20("Test USD", "tUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
