// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ServiceSpec, Roles, IEntitlementClasses} from "./RouteLockTypes.sol";
import {ServiceEntitlement} from "./ServiceEntitlement.sol";
import {SettlementEscrow} from "./SettlementEscrow.sol";

/// @title EntitlementFactory
/// @notice Registers issuers, defines classes of service, and mints entitlements.
///
/// Every mint passes through the backing check in `SettlementEscrow`, so
/// uncollateralized issuance is not reachable by any call sequence — not by an
/// issuer minting to themselves, not by an admin, not by reentering during the
/// ERC-721 receive hook.
contract EntitlementFactory is AccessControl, ReentrancyGuard, IEntitlementClasses {
    error IssuerNotRegistered(address issuer);
    error IssuerPaused(address issuer);
    error ClassExists(bytes32 classId);
    error NoSuchClass(bytes32 classId);
    error NotClassIssuer(bytes32 classId, address caller);
    error ClassIsPaused(bytes32 classId);
    error ClassExpired(bytes32 classId, uint64 validUntil);
    error SupplyExhausted(bytes32 classId, uint32 maxSupply);
    error SupplyCannotShrink(bytes32 classId, uint32 current, uint32 requested);
    error ValidityInPast(uint64 validUntil);
    error ZeroAddress();
    error ZeroSupply();

    event IssuerRegistered(address indexed issuer);
    event IssuerPauseSet(address indexed issuer, bool paused);
    event ClassCreated(bytes32 indexed classId, address indexed issuer, uint256 pricePerUnit, uint32 maxSupply);
    event ClassPauseSet(bytes32 indexed classId, bool paused);
    event SupplyIncreased(bytes32 indexed classId, uint32 from, uint32 to);
    event EntitlementPurchased(bytes32 indexed classId, uint256 indexed tokenId, address indexed buyer);

    ServiceEntitlement public immutable entitlement;
    SettlementEscrow public immutable escrow;

    mapping(address issuer => bool) public isRegisteredIssuer;
    mapping(address issuer => bool) public isPausedIssuer;
    mapping(bytes32 classId => ServiceSpec) private _classes;

    constructor(address admin, address entitlement_, address escrow_) {
        if (admin == address(0) || entitlement_ == address(0) || escrow_ == address(0)) {
            revert ZeroAddress();
        }
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(Roles.ADMIN_ROLE, admin);

        entitlement = ServiceEntitlement(entitlement_);
        escrow = SettlementEscrow(escrow_);
    }

    // ---------------------------------------------------------------------
    // Issuer administration
    // ---------------------------------------------------------------------

    function registerIssuer(address issuer) external onlyRole(Roles.ADMIN_ROLE) {
        if (issuer == address(0)) revert ZeroAddress();
        isRegisteredIssuer[issuer] = true;
        _grantRole(Roles.ISSUER_ROLE, issuer);
        emit IssuerRegistered(issuer);
    }

    /// @notice Pausing an issuer stops new classes and new mints. It does not
    ///         touch entitlements already sold — those remain the holder's
    ///         property and stay redeemable.
    function pauseIssuer(address issuer, bool paused) external onlyRole(Roles.ADMIN_ROLE) {
        if (!isRegisteredIssuer[issuer]) revert IssuerNotRegistered(issuer);
        isPausedIssuer[issuer] = paused;
        emit IssuerPauseSet(issuer, paused);
    }

    // ---------------------------------------------------------------------
    // Classes
    // ---------------------------------------------------------------------

    function createClass(
        bytes32 classId,
        bytes32 termsHash,
        address settlementToken,
        uint256 pricePerUnit,
        uint256 payoutObligation,
        uint64 validUntil,
        uint32 maxSupply
    ) external {
        _requireActiveIssuer(msg.sender);
        if (_classes[classId].issuer != address(0)) revert ClassExists(classId);
        if (settlementToken == address(0)) revert ZeroAddress();
        if (maxSupply == 0) revert ZeroSupply();
        if (validUntil <= block.timestamp) revert ValidityInPast(validUntil);

        _classes[classId] = ServiceSpec({
            classId: classId,
            issuer: msg.sender,
            termsHash: termsHash,
            settlementToken: settlementToken,
            pricePerUnit: pricePerUnit,
            payoutObligation: payoutObligation,
            validUntil: validUntil,
            maxSupply: maxSupply,
            minted: 0,
            paused: false
        });

        escrow.registerClass(classId, msg.sender, settlementToken, payoutObligation);

        emit ClassCreated(classId, msg.sender, pricePerUnit, maxSupply);
    }

    /// @dev `validUntil` is deliberately absent here. Validity is a term of the
    ///      commitment a buyer paid for, so it is immutable after creation.
    function increaseSupply(bytes32 classId, uint32 newMaxSupply) external {
        ServiceSpec storage spec = _requireClass(classId);
        if (spec.issuer != msg.sender) revert NotClassIssuer(classId, msg.sender);
        _requireActiveIssuer(msg.sender);
        if (newMaxSupply <= spec.maxSupply) {
            revert SupplyCannotShrink(classId, spec.maxSupply, newMaxSupply);
        }

        uint32 previous = spec.maxSupply;
        spec.maxSupply = newMaxSupply;
        emit SupplyIncreased(classId, previous, newMaxSupply);
    }

    function pauseClass(bytes32 classId, bool paused) external {
        ServiceSpec storage spec = _requireClass(classId);
        if (spec.issuer != msg.sender) revert NotClassIssuer(classId, msg.sender);
        spec.paused = paused;
        emit ClassPauseSet(classId, paused);
    }

    // ---------------------------------------------------------------------
    // Purchase
    // ---------------------------------------------------------------------

    /// @notice Buy one entitlement of `classId`.
    ///
    /// The buyer approves `SettlementEscrow`, not this contract — funds move
    /// directly from buyer to escrow and never rest anywhere they could be
    /// diverted.
    function mint(bytes32 classId, address to) external nonReentrant returns (uint256 tokenId) {
        ServiceSpec storage spec = _requireClass(classId);
        if (to == address(0)) revert ZeroAddress();
        if (spec.paused) revert ClassIsPaused(classId);
        if (isPausedIssuer[spec.issuer]) revert IssuerPaused(spec.issuer);
        if (block.timestamp > spec.validUntil) revert ClassExpired(classId, spec.validUntil);
        if (spec.minted >= spec.maxSupply) revert SupplyExhausted(classId, spec.maxSupply);

        spec.minted += 1;

        tokenId = entitlement.mint(to, classId);
        escrow.recordMint(tokenId, classId, msg.sender, spec.pricePerUnit);

        emit EntitlementPurchased(classId, tokenId, msg.sender);
    }

    // ---------------------------------------------------------------------
    // IEntitlementClasses
    // ---------------------------------------------------------------------

    function classIssuer(bytes32 classId) external view returns (address) {
        return _classes[classId].issuer;
    }

    function classValidUntil(bytes32 classId) external view returns (uint64) {
        return _classes[classId].validUntil;
    }

    function classExists(bytes32 classId) external view returns (bool) {
        return _classes[classId].issuer != address(0);
    }

    function getClass(bytes32 classId) external view returns (ServiceSpec memory) {
        return _classes[classId];
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _requireClass(bytes32 classId) private view returns (ServiceSpec storage spec) {
        spec = _classes[classId];
        if (spec.issuer == address(0)) revert NoSuchClass(classId);
    }

    function _requireActiveIssuer(address issuer) private view {
        if (!isRegisteredIssuer[issuer]) revert IssuerNotRegistered(issuer);
        if (isPausedIssuer[issuer]) revert IssuerPaused(issuer);
    }
}
