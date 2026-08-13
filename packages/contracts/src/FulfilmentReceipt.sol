// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {Roles} from "./RouteLockTypes.sol";

/// @title FulfilmentReceipt
/// @notice A soulbound record that an issuer delivered on a commitment.
///
/// Minted to the issuer on delivery. It carries the class, the issuer, and the
/// timestamps — and deliberately nothing about the counterparty. An issuer's
/// reputation should be verifiable without their customer list being public, so
/// the recipient, the contents, and the route detail are all absent by design.
contract FulfilmentReceipt is ERC721, AccessControl {
    /// @dev Soulbound: reputation that can be sold is not reputation.
    error Soulbound();
    error ReceiptExists(uint256 entitlementTokenId);
    error ZeroAddress();

    event ReceiptMinted(
        uint256 indexed receiptId,
        uint256 indexed entitlementTokenId,
        bytes32 indexed classId,
        address issuer
    );

    struct Receipt {
        uint256 entitlementTokenId;
        bytes32 classId;
        address issuer;
        uint64 activatedAt;
        uint64 deliveredAt;
    }

    mapping(uint256 receiptId => Receipt) public receipts;
    mapping(uint256 entitlementTokenId => uint256 receiptId) public receiptFor;

    uint256 private _nextReceiptId = 1;

    constructor(address admin) ERC721("RouteLock Fulfilment Receipt", "RLFR") {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(Roles.ADMIN_ROLE, admin);
    }

    /// @notice Mint the receipt for a delivered entitlement. Oracle-only, because
    ///         delivery is a carrier-sourced fact.
    function mintReceipt(
        uint256 entitlementTokenId,
        bytes32 classId,
        address issuer,
        uint64 activatedAt
    ) external onlyRole(Roles.ORACLE_ROLE) returns (uint256 receiptId) {
        if (issuer == address(0)) revert ZeroAddress();
        if (receiptFor[entitlementTokenId] != 0) revert ReceiptExists(entitlementTokenId);

        receiptId = _nextReceiptId++;
        receipts[receiptId] = Receipt({
            entitlementTokenId: entitlementTokenId,
            classId: classId,
            issuer: issuer,
            activatedAt: activatedAt,
            deliveredAt: uint64(block.timestamp)
        });
        receiptFor[entitlementTokenId] = receiptId;

        _safeMint(issuer, receiptId);

        emit ReceiptMinted(receiptId, entitlementTokenId, classId, issuer);
    }

    function totalReceipts() external view returns (uint256) {
        return _nextReceiptId - 1;
    }

    /// @dev Permits minting, forbids every subsequent movement.
    function _update(address to, uint256 tokenId, address auth)
        internal
        override
        returns (address)
    {
        if (_ownerOf(tokenId) != address(0)) revert Soulbound();
        return super._update(to, tokenId, auth);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
