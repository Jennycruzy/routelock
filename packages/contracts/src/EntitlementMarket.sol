// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {ServiceEntitlement} from "./ServiceEntitlement.sol";
import {EntitlementState} from "./RouteLockTypes.sol";

/// @title EntitlementMarket
/// @notice Peer-to-peer resale of unbound entitlements, at a price the two
///         parties agree.
///
/// ## Additive by construction
///
/// This contract holds **no role on anything**. It is not wired into the
/// factory, the escrow or the registry, it is not referenced by any of them, and
/// nothing about the deployed five changes because it exists. It is an ordinary
/// ERC-721 counterparty that happens to know what an entitlement's state means.
/// If it were removed tomorrow, every other contract would behave identically.
///
/// That is deliberate. The five contracts carry a real fulfilment and a passing
/// coverage target; a resale venue is worth having and is not worth reopening
/// them for.
///
/// ## What is actually being sold
///
/// An `Available` entitlement is a claim on a named issuer's commitment and
/// nothing more. It names no consignee, carries no parcel data and identifies no
/// shipment. Two entitlements of the same class in that state are
/// interchangeable — which is the definition of fungible, and is why a resale
/// market for them is economically honest rather than decorative.
///
/// The moment consignment data binds a token, that stops being true: the token
/// now describes one specific shipment for one specific counterparty.
/// `ServiceEntitlement` enforces this itself, refusing every transfer of a token
/// that has left `Available`.
///
/// ## Why this contract re-checks what the token already enforces
///
/// It would be enough, for correctness, to let `ServiceEntitlement._update`
/// revert. This contract checks anyway, in both places, and the reason is the
/// gap between the two moments:
///
///   **At listing**, a check answers "is this sellable *now*", which is what a
///   seller expects to be told immediately rather than at settlement.
///
///   **At purchase**, the check is not a convenience — it is the correctness
///   property. State can change between listing and purchase: a token listed
///   while `Available` can be submitted for review, approved and activated
///   before anyone buys it. A market that validated only at listing time would
///   carry a stale permission, and while the ERC-721 transfer would still
///   revert, the buyer's payment leg must not be allowed to run first. So
///   `buy()` re-reads state at execution and refuses on its own terms, with an
///   error naming the state, before any value moves.
///
/// A listing is therefore a standing offer, never a right. It can be
/// invalidated by the token's own lifecycle without anyone touching this
/// contract, and that is the expected behaviour rather than an edge case.
contract EntitlementMarket is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev The token is bound to a shipment and is no longer interchangeable.
    ///      Carries the state so an operator is told *why*, not merely "no".
    error EntitlementBound(uint256 tokenId, EntitlementState state);

    error NotOwner(uint256 tokenId, address caller, address owner);
    error NotListed(uint256 tokenId);
    error AlreadyListed(uint256 tokenId);
    error MarketNotApproved(uint256 tokenId);
    error SellerNoLongerOwns(uint256 tokenId, address seller, address owner);
    error PriceChanged(uint256 tokenId, uint256 expected, uint256 actual);
    error CannotBuyOwnListing(uint256 tokenId);
    error ZeroAddress();
    error ZeroPrice();

    event Listed(uint256 indexed tokenId, address indexed seller, uint256 price);
    event Cancelled(uint256 indexed tokenId, address indexed seller);
    event Sold(uint256 indexed tokenId, address indexed seller, address indexed buyer, uint256 price);

    struct Listing {
        address seller;
        uint256 price;
    }

    ServiceEntitlement public immutable entitlement;
    IERC20 public immutable settlementToken;

    mapping(uint256 tokenId => Listing) public listings;

    constructor(address entitlement_, address settlementToken_) {
        if (entitlement_ == address(0) || settlementToken_ == address(0)) revert ZeroAddress();
        entitlement = ServiceEntitlement(entitlement_);
        settlementToken = IERC20(settlementToken_);
    }

    /// @notice Offer an unbound entitlement for sale.
    ///
    /// The market is not given custody. The seller keeps the token and grants an
    /// ERC-721 approval, so a listing never immobilises an asset and a seller
    /// who changes their mind can simply revoke the approval. The cost of that
    /// choice is that a listing can go stale, which `buy()` is written to expect.
    function list(uint256 tokenId, uint256 price) external {
        if (price == 0) revert ZeroPrice();

        address owner = entitlement.ownerOf(tokenId);
        if (owner != msg.sender) revert NotOwner(tokenId, msg.sender, owner);
        if (listings[tokenId].seller != address(0)) revert AlreadyListed(tokenId);

        _requireUnbound(tokenId);

        // Checked at listing so the seller finds out now rather than watching
        // buyers fail. It is not a substitute for the check in `buy()`: an
        // approval can be revoked at any time afterwards.
        if (
            entitlement.getApproved(tokenId) != address(this)
                && !entitlement.isApprovedForAll(owner, address(this))
        ) {
            revert MarketNotApproved(tokenId);
        }

        listings[tokenId] = Listing({seller: msg.sender, price: price});
        emit Listed(tokenId, msg.sender, price);
    }

    /// @notice Withdraw a listing. Seller only.
    function cancel(uint256 tokenId) external {
        Listing memory listing = listings[tokenId];
        if (listing.seller == address(0)) revert NotListed(tokenId);
        if (listing.seller != msg.sender) revert NotOwner(tokenId, msg.sender, listing.seller);

        delete listings[tokenId];
        emit Cancelled(tokenId, msg.sender);
    }

    /// @notice Buy a listed entitlement at `expectedPrice`.
    ///
    /// `expectedPrice` is not ceremony. Without it, a seller could cancel and
    /// relist at a higher price in front of a pending purchase and have it fill
    /// at the new number. The buyer states the price they agreed to and the
    /// transaction reverts if it is not the price on offer.
    function buy(uint256 tokenId, uint256 expectedPrice) external nonReentrant {
        Listing memory listing = listings[tokenId];
        if (listing.seller == address(0)) revert NotListed(tokenId);
        if (listing.price != expectedPrice) revert PriceChanged(tokenId, expectedPrice, listing.price);
        if (listing.seller == msg.sender) revert CannotBuyOwnListing(tokenId);

        // The two ways a listing goes stale, both checked before any value
        // moves. Neither is an error by the buyer, so both name what happened.
        address owner = entitlement.ownerOf(tokenId);
        if (owner != listing.seller) revert SellerNoLongerOwns(tokenId, listing.seller, owner);

        // The correctness property. A token listed while `Available` can be
        // submitted, approved and activated before this call lands; the ERC-721
        // transfer would revert on its own, but only after the payment leg had
        // already run. Refusing here keeps the buyer's funds where they are.
        _requireUnbound(tokenId);

        // Effects before interactions: the listing is gone before either token
        // moves, so a callback re-entering `buy` finds nothing to buy. The
        // settlement token is a known 6-decimal stablecoin rather than an
        // arbitrary ERC-20, but the ordering does not depend on that.
        delete listings[tokenId];

        settlementToken.safeTransferFrom(msg.sender, listing.seller, listing.price);
        IERC721(address(entitlement)).safeTransferFrom(listing.seller, msg.sender, tokenId);

        emit Sold(tokenId, listing.seller, msg.sender, listing.price);
    }

    /// @notice Whether `tokenId` could be listed or bought right now.
    ///
    /// A view for a frontend, so a UI can grey a button out instead of offering
    /// a sale that reverts. It is not consulted by `list` or `buy` — those do
    /// their own checking, because a view a caller may skip is not a guard.
    function isSellable(uint256 tokenId) external view returns (bool) {
        return entitlement.exists(tokenId) && entitlement.stateOf(tokenId) == EntitlementState.Available;
    }

    /// @dev One definition of "unbound", used by both entry points so they can
    ///      never drift apart.
    function _requireUnbound(uint256 tokenId) private view {
        EntitlementState state = entitlement.stateOf(tokenId);
        if (state != EntitlementState.Available) revert EntitlementBound(tokenId, state);
    }
}
