// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {EntitlementState, Roles, IEntitlementClasses} from "./RouteLockTypes.sol";

/// @title ServiceEntitlement
/// @notice A transferable claim on a named issuer's real contractual commitment.
///
/// The token is generic on purpose. It knows its class and its lifecycle state;
/// it knows nothing about parcels, carriers, or customs. That separation is what
/// makes the same contract usable for a pallet-month of bonded storage or an
/// hour of machine time, with delivery as one adapter rather than the whole
/// product.
///
/// State machine:
///
///     Available      --submitParcel--> PendingReview
///     PendingReview  --reject-------->  Available
///     PendingReview  --approve------->  Activated        (transfers lock here)
///     Activated      --label--------->  LabelCreated
///     LabelCreated   --pickup-------->  InTransit
///     InTransit      --delivery------>  Delivered
///     Activated |
///     LabelCreated |
///     InTransit      --remedy-------->  Remedied
///     Available      --expire-------->  Expired
contract ServiceEntitlement is ERC721, AccessControl {
    /// @dev Transfers are permitted only in `Available`.
    ///
    /// This is a privacy and integrity control, not a restriction on utility.
    /// Once parcel data and a consignee are bound to a token, transferring it
    /// would either leak the recipient's details to whoever receives the token,
    /// or let a shipment the carrier has already accepted be redirected. Neither
    /// is acceptable, so the token stops being transferable at exactly the point
    /// it stops being a generic claim and starts describing a real person's
    /// delivery.
    error TransferLocked(uint256 tokenId, EntitlementState state);

    error InvalidTransition(uint256 tokenId, EntitlementState from, EntitlementState to);
    error UnknownToken(uint256 tokenId);
    error NotYetExpired(uint256 tokenId, uint64 validUntil);
    error FactoryAlreadySet();
    error ZeroAddress();

    event EntitlementMinted(uint256 indexed tokenId, bytes32 indexed classId, address indexed to);
    event StateChanged(uint256 indexed tokenId, EntitlementState indexed from, EntitlementState indexed to);

    /// @notice Class of each token. Immutable once minted.
    mapping(uint256 tokenId => bytes32 classId) public classOf;

    /// @notice Lifecycle state of each token.
    mapping(uint256 tokenId => EntitlementState) public stateOf;

    /// @notice Source of class metadata (the factory). Set once, after deployment,
    ///         because the factory needs this contract's address at construction.
    IEntitlementClasses public classes;

    uint256 private _nextTokenId = 1;

    constructor(string memory name_, string memory symbol_, address admin) ERC721(name_, symbol_) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(Roles.ADMIN_ROLE, admin);
    }

    // ---------------------------------------------------------------------
    // Wiring
    // ---------------------------------------------------------------------

    /// @notice Point this contract at the factory. One-time, so the class source
    ///         cannot be swapped underneath live tokens.
    function setClasses(address factory) external onlyRole(Roles.ADMIN_ROLE) {
        if (factory == address(0)) revert ZeroAddress();
        if (address(classes) != address(0)) revert FactoryAlreadySet();
        classes = IEntitlementClasses(factory);
    }

    // ---------------------------------------------------------------------
    // Minting
    // ---------------------------------------------------------------------

    /// @notice Mint one entitlement. Only the factory may call this, because only
    ///         the factory checks supply limits and collateral backing.
    function mint(address to, bytes32 classId)
        external
        onlyRole(Roles.FACTORY_ROLE)
        returns (uint256 tokenId)
    {
        tokenId = _nextTokenId++;
        classOf[tokenId] = classId;
        stateOf[tokenId] = EntitlementState.Available;
        _safeMint(to, tokenId);

        emit EntitlementMinted(tokenId, classId, to);
        emit StateChanged(tokenId, EntitlementState.None, EntitlementState.Available);
    }

    // ---------------------------------------------------------------------
    // Review transitions — driven by ActivationRegistry
    // ---------------------------------------------------------------------

    function submitParcel(uint256 tokenId) external onlyRole(Roles.REGISTRY_ROLE) {
        _transition(tokenId, EntitlementState.Available, EntitlementState.PendingReview);
    }

    /// @notice Compliance refused or asked for more information. The token
    ///         returns to `Available` and stays fully usable — refusal costs the
    ///         holder nothing but time.
    function rejectActivation(uint256 tokenId) external onlyRole(Roles.REGISTRY_ROLE) {
        _transition(tokenId, EntitlementState.PendingReview, EntitlementState.Available);
    }

    /// @notice Compliance approved. Transfers lock from here on.
    function approveActivation(uint256 tokenId) external onlyRole(Roles.REGISTRY_ROLE) {
        _transition(tokenId, EntitlementState.PendingReview, EntitlementState.Activated);
    }

    // ---------------------------------------------------------------------
    // Carrier-sourced transitions — written by the backend oracle
    // ---------------------------------------------------------------------

    function recordLabel(uint256 tokenId) external onlyRole(Roles.ORACLE_ROLE) {
        _transition(tokenId, EntitlementState.Activated, EntitlementState.LabelCreated);
    }

    function recordPickup(uint256 tokenId) external onlyRole(Roles.ORACLE_ROLE) {
        _transition(tokenId, EntitlementState.LabelCreated, EntitlementState.InTransit);
    }

    function recordDelivery(uint256 tokenId) external onlyRole(Roles.ORACLE_ROLE) {
        _transition(tokenId, EntitlementState.InTransit, EntitlementState.Delivered);
    }

    // ---------------------------------------------------------------------
    // Remedy and expiry
    // ---------------------------------------------------------------------

    /// @notice The issuer failed to honour a bound entitlement. Reachable from
    ///         any state after activation but before delivery.
    function recordRemedy(uint256 tokenId) external onlyRole(Roles.ADMIN_ROLE) {
        EntitlementState current = stateOf[tokenId];
        if (
            current != EntitlementState.Activated && current != EntitlementState.LabelCreated
                && current != EntitlementState.InTransit
        ) {
            revert InvalidTransition(tokenId, current, EntitlementState.Remedied);
        }
        stateOf[tokenId] = EntitlementState.Remedied;
        emit StateChanged(tokenId, current, EntitlementState.Remedied);
    }

    /// @notice Retire an unused entitlement past its class validity window.
    ///
    /// Permissionless by design: expiry is a fact about the clock, not a
    /// decision, so it should not depend on a privileged party remembering to
    /// call it. Only `Available` tokens expire — anything already in review or
    /// activated is mid-flight and must resolve through its own path.
    function expire(uint256 tokenId) external {
        EntitlementState current = stateOf[tokenId];
        if (current == EntitlementState.None) revert UnknownToken(tokenId);
        if (current != EntitlementState.Available) {
            revert InvalidTransition(tokenId, current, EntitlementState.Expired);
        }

        uint64 validUntil = classes.classValidUntil(classOf[tokenId]);
        if (block.timestamp <= validUntil) revert NotYetExpired(tokenId, validUntil);

        stateOf[tokenId] = EntitlementState.Expired;
        emit StateChanged(tokenId, current, EntitlementState.Expired);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function exists(uint256 tokenId) external view returns (bool) {
        return stateOf[tokenId] != EntitlementState.None;
    }

    function totalMinted() external view returns (uint256) {
        return _nextTokenId - 1;
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _transition(uint256 tokenId, EntitlementState from, EntitlementState to) private {
        EntitlementState current = stateOf[tokenId];
        if (current == EntitlementState.None) revert UnknownToken(tokenId);
        if (current != from) revert InvalidTransition(tokenId, current, to);

        stateOf[tokenId] = to;
        emit StateChanged(tokenId, current, to);
    }

    /// @dev Enforces the transfer lock. Minting (`from == 0`) is always allowed;
    ///      every other movement requires the token to be `Available`.
    function _update(address to, uint256 tokenId, address auth)
        internal
        override
        returns (address)
    {
        address from = _ownerOf(tokenId);
        if (from != address(0)) {
            EntitlementState current = stateOf[tokenId];
            if (current != EntitlementState.Available) {
                revert TransferLocked(tokenId, current);
            }
        }
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
