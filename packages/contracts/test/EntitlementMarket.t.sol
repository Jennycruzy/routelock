// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {RouteLockBase} from "./RouteLockBase.t.sol";
import {EntitlementMarket} from "../src/EntitlementMarket.sol";
import {ServiceEntitlement} from "../src/ServiceEntitlement.sol";
import {EntitlementState} from "../src/RouteLockTypes.sol";
import {Verdict} from "../src/ActivationRegistry.sol";

/// @notice A settlement token that calls back into the market mid-transfer.
///
/// The realistic shape of the risk: ERC-777-style hooks and fee-on-transfer
/// wrappers both hand control to a third party in the middle of a transfer. The
/// deployed settlement tokens are plain 6-decimal stablecoins that do no such
/// thing, which is exactly why the ordering in `buy` must not *depend* on that
/// being true.
contract ReentrantToken is ERC20 {
    EntitlementMarket public market;
    uint256 private tokenId;
    uint256 private price;
    bool private entered;

    /// @notice The revert data from the re-entrant call, captured rather than
    ///         propagated — a reverting callback inside a transfer would abort
    ///         the whole purchase and prove nothing about which guard fired.
    bytes public reentryRevert;
    bool public reentered;

    constructor() ERC20("Reentrant USD", "rUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(EntitlementMarket market_, uint256 tokenId_, uint256 price_) external {
        market = market_;
        tokenId = tokenId_;
        price = price_;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);

        if (address(market) != address(0) && !entered) {
            entered = true;
            reentered = true;
            try market.buy(tokenId, price) {
                reentryRevert = hex"";
            } catch (bytes memory reason) {
                reentryRevert = reason;
            }
        }
    }
}

contract EntitlementMarketTest is RouteLockBase {
    EntitlementMarket internal market;

    address internal reseller = makeAddr("reseller");

    uint256 internal constant RESALE_PRICE = 15_000_000; // 15.00 tUSD

    function setUp() public override {
        super.setUp();
        market = new EntitlementMarket(address(entitlement), address(token));
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _ownedListing() internal returns (uint256 tokenId) {
        tokenId = _classWithOneEntitlement();

        vm.startPrank(buyer);
        entitlement.approve(address(market), tokenId);
        market.list(tokenId, RESALE_PRICE);
        vm.stopPrank();
    }

    function _fundReseller() internal {
        token.mint(reseller, RESALE_PRICE);
        vm.prank(reseller);
        token.approve(address(market), RESALE_PRICE);
    }

    // ---------------------------------------------------------------------
    // The property this contract exists to guarantee
    // ---------------------------------------------------------------------

    /// A bound entitlement names a consignee and describes one specific
    /// shipment. It is not interchangeable with anything, so it is not
    /// tradeable, and the market must say so itself rather than relying on the
    /// ERC-721 transfer to fail later.
    function test_boundEntitlementCannotBeListed() public {
        uint256 tokenId = _classWithOneEntitlement();

        vm.prank(buyer);
        entitlement.approve(address(market), tokenId);

        _submit(tokenId, buyer);
        _assertState(tokenId, EntitlementState.PendingReview);

        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                EntitlementMarket.EntitlementBound.selector, tokenId, EntitlementState.PendingReview
            )
        );
        market.list(tokenId, RESALE_PRICE);
    }

    /// Every state that is not `Available` is refused, not merely the one that
    /// happened to be tested. Enumerated so a new lifecycle state cannot quietly
    /// become sellable.
    function test_noStateOtherThanAvailableCanBeListed() public {
        EntitlementState[4] memory bound = [
            EntitlementState.PendingReview,
            EntitlementState.Activated,
            EntitlementState.LabelCreated,
            EntitlementState.InTransit
        ];

        _createClass();
        _fundCollateral(OBLIGATION * MAX_SUPPLY);

        for (uint256 i = 0; i < bound.length; i++) {
            uint256 tokenId = _buy(buyer);

            vm.prank(buyer);
            entitlement.approve(address(market), tokenId);

            _submit(tokenId, buyer);
            if (i >= 1) _decide(tokenId, Verdict.Approved);
            if (i >= 2) {
                vm.prank(oracle);
                entitlement.recordLabel(tokenId);
            }
            if (i >= 3) {
                vm.prank(oracle);
                entitlement.recordPickup(tokenId);
            }

            _assertState(tokenId, bound[i]);

            vm.prank(buyer);
            vm.expectRevert(
                abi.encodeWithSelector(EntitlementMarket.EntitlementBound.selector, tokenId, bound[i])
            );
            market.list(tokenId, RESALE_PRICE);
        }
    }

    /// The one that matters most, because it is the one a listing-time-only
    /// check would get wrong. The token was legitimately `Available` when
    /// listed; it is bound by the time the buyer arrives. The purchase must
    /// refuse on the market's own terms, before any value moves.
    function test_aListingGoesStaleWhenTheTokenIsBoundAfterwards() public {
        uint256 tokenId = _ownedListing();
        _fundReseller();

        _submit(tokenId, buyer);
        _assertState(tokenId, EntitlementState.PendingReview);

        vm.prank(reseller);
        vm.expectRevert(
            abi.encodeWithSelector(
                EntitlementMarket.EntitlementBound.selector, tokenId, EntitlementState.PendingReview
            )
        );
        market.buy(tokenId, RESALE_PRICE);

        // The buyer's money never left, and the seller still holds the token.
        assertEq(token.balanceOf(reseller), RESALE_PRICE, "buyer was charged for a refused purchase");
        assertEq(entitlement.ownerOf(tokenId), buyer, "token moved on a refused purchase");
    }

    // ---------------------------------------------------------------------
    // The happy path
    // ---------------------------------------------------------------------

    function test_anAvailableEntitlementSellsAndSettles() public {
        uint256 tokenId = _ownedListing();
        _fundReseller();

        uint256 sellerBefore = token.balanceOf(buyer);

        vm.expectEmit(true, true, true, true, address(market));
        emit EntitlementMarket.Sold(tokenId, buyer, reseller, RESALE_PRICE);

        vm.prank(reseller);
        market.buy(tokenId, RESALE_PRICE);

        assertEq(entitlement.ownerOf(tokenId), reseller, "buyer did not receive the token");
        assertEq(token.balanceOf(buyer), sellerBefore + RESALE_PRICE, "seller was not paid");
        assertEq(token.balanceOf(reseller), 0, "buyer was not charged");

        (address seller,) = market.listings(tokenId);
        assertEq(seller, address(0), "listing survived the sale");
    }

    /// The resold token is still a live entitlement, and its new owner can use
    /// it. A resale that produced a token nobody could submit would be a market
    /// in worthless paper.
    function test_theNewOwnerCanStillUseWhatTheyBought() public {
        uint256 tokenId = _ownedListing();
        _fundReseller();

        vm.prank(reseller);
        market.buy(tokenId, RESALE_PRICE);

        _submit(tokenId, reseller);
        _assertState(tokenId, EntitlementState.PendingReview);
    }

    function test_isSellableTracksTheLifecycle() public {
        uint256 tokenId = _classWithOneEntitlement();
        assertTrue(market.isSellable(tokenId), "an Available token should be sellable");

        _submit(tokenId, buyer);
        assertFalse(market.isSellable(tokenId), "a bound token should not be sellable");

        assertFalse(market.isSellable(9999), "a token that does not exist is not sellable");
    }

    // ---------------------------------------------------------------------
    // Listing rules
    // ---------------------------------------------------------------------

    function test_onlyTheOwnerCanList() public {
        uint256 tokenId = _classWithOneEntitlement();

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(EntitlementMarket.NotOwner.selector, tokenId, stranger, buyer)
        );
        market.list(tokenId, RESALE_PRICE);
    }

    function test_listingWithoutApprovalIsRefusedAtListingTime() public {
        uint256 tokenId = _classWithOneEntitlement();

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(EntitlementMarket.MarketNotApproved.selector, tokenId));
        market.list(tokenId, RESALE_PRICE);
    }

    function test_blanketApprovalIsAlsoAccepted() public {
        uint256 tokenId = _classWithOneEntitlement();

        vm.startPrank(buyer);
        entitlement.setApprovalForAll(address(market), true);
        market.list(tokenId, RESALE_PRICE);
        vm.stopPrank();

        (address seller, uint256 price) = market.listings(tokenId);
        assertEq(seller, buyer);
        assertEq(price, RESALE_PRICE);
    }

    function test_aFreeListingIsRefused() public {
        uint256 tokenId = _classWithOneEntitlement();

        vm.prank(buyer);
        vm.expectRevert(EntitlementMarket.ZeroPrice.selector);
        market.list(tokenId, 0);
    }

    function test_listingTwiceIsRefused() public {
        uint256 tokenId = _ownedListing();

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(EntitlementMarket.AlreadyListed.selector, tokenId));
        market.list(tokenId, RESALE_PRICE);
    }

    function test_sellerCanCancelAndTheListingStopsBeingBuyable() public {
        uint256 tokenId = _ownedListing();
        _fundReseller();

        vm.prank(buyer);
        market.cancel(tokenId);

        vm.prank(reseller);
        vm.expectRevert(abi.encodeWithSelector(EntitlementMarket.NotListed.selector, tokenId));
        market.buy(tokenId, RESALE_PRICE);
    }

    function test_onlyTheSellerCanCancel() public {
        uint256 tokenId = _ownedListing();

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(EntitlementMarket.NotOwner.selector, tokenId, stranger, buyer)
        );
        market.cancel(tokenId);
    }

    function test_cancellingSomethingUnlistedIsRefused() public {
        uint256 tokenId = _classWithOneEntitlement();

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(EntitlementMarket.NotListed.selector, tokenId));
        market.cancel(tokenId);
    }

    // ---------------------------------------------------------------------
    // Purchase rules
    // ---------------------------------------------------------------------

    /// Without the expected-price argument, a seller could cancel, relist
    /// higher, and have a pending purchase fill at the new number.
    function test_aBuyerCannotBeFilledAtAPriceTheyDidNotAgree() public {
        uint256 tokenId = _ownedListing();
        _fundReseller();

        vm.startPrank(buyer);
        market.cancel(tokenId);
        market.list(tokenId, RESALE_PRICE * 2);
        vm.stopPrank();

        vm.prank(reseller);
        vm.expectRevert(
            abi.encodeWithSelector(
                EntitlementMarket.PriceChanged.selector, tokenId, RESALE_PRICE, RESALE_PRICE * 2
            )
        );
        market.buy(tokenId, RESALE_PRICE);
    }

    /// A listing is a standing offer, not an escrow: the seller keeps custody
    /// and can move the token out from under it.
    function test_aListingBySomeoneWhoNoLongerOwnsTheTokenIsRefused() public {
        uint256 tokenId = _ownedListing();
        _fundReseller();

        vm.prank(buyer);
        entitlement.transferFrom(buyer, stranger, tokenId);

        vm.prank(reseller);
        vm.expectRevert(
            abi.encodeWithSelector(
                EntitlementMarket.SellerNoLongerOwns.selector, tokenId, buyer, stranger
            )
        );
        market.buy(tokenId, RESALE_PRICE);
    }

    /// A revoked approval fails in the ERC-721 layer rather than here, which is
    /// correct — but it must fail, and the buyer must not be charged.
    function test_aRevokedApprovalStopsTheSaleWithoutChargingTheBuyer() public {
        uint256 tokenId = _ownedListing();
        _fundReseller();

        vm.prank(buyer);
        entitlement.approve(address(0), tokenId);

        vm.prank(reseller);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC721Errors.ERC721InsufficientApproval.selector, address(market), tokenId
            )
        );
        market.buy(tokenId, RESALE_PRICE);

        assertEq(token.balanceOf(reseller), RESALE_PRICE, "buyer was charged for a failed sale");
    }

    function test_buyingSomethingUnlistedIsRefused() public {
        uint256 tokenId = _classWithOneEntitlement();

        vm.prank(reseller);
        vm.expectRevert(abi.encodeWithSelector(EntitlementMarket.NotListed.selector, tokenId));
        market.buy(tokenId, RESALE_PRICE);
    }

    function test_sellerCannotBuyTheirOwnListing() public {
        uint256 tokenId = _ownedListing();
        token.mint(buyer, RESALE_PRICE);

        vm.startPrank(buyer);
        token.approve(address(market), RESALE_PRICE);
        vm.expectRevert(abi.encodeWithSelector(EntitlementMarket.CannotBuyOwnListing.selector, tokenId));
        market.buy(tokenId, RESALE_PRICE);
        vm.stopPrank();
    }

    function test_aBuyerWhoCannotPayDoesNotGetTheToken() public {
        uint256 tokenId = _ownedListing();
        // Deliberately unfunded and unapproved.

        vm.prank(reseller);
        vm.expectRevert();
        market.buy(tokenId, RESALE_PRICE);

        assertEq(entitlement.ownerOf(tokenId), buyer, "token moved without payment");
    }

    // ---------------------------------------------------------------------
    // Reentrancy
    // ---------------------------------------------------------------------

    /// `buy` deletes the listing before it moves anything, so a token that hands
    /// control away mid-transfer finds nothing left to buy. The `nonReentrant`
    /// guard would also stop this; the point of the test is that the ordering
    /// holds on its own, because a guard is one line away from being removed by
    /// someone who believes the settlement token is well behaved.
    function test_aTokenThatCallsBackFindsTheListingAlreadyGone() public {
        ReentrantToken evil = new ReentrantToken();
        EntitlementMarket evilMarket = new EntitlementMarket(address(entitlement), address(evil));

        uint256 tokenId = _classWithOneEntitlement();

        vm.startPrank(buyer);
        entitlement.approve(address(evilMarket), tokenId);
        evilMarket.list(tokenId, RESALE_PRICE);
        vm.stopPrank();

        evil.mint(reseller, RESALE_PRICE);
        vm.prank(reseller);
        evil.approve(address(evilMarket), RESALE_PRICE);

        evil.arm(evilMarket, tokenId, RESALE_PRICE);

        vm.prank(reseller);
        evilMarket.buy(tokenId, RESALE_PRICE);

        assertTrue(evil.reentered(), "the callback never fired, so the test proved nothing");

        // Either guard is an acceptable answer; silence is not. What must never
        // happen is the second purchase succeeding.
        bytes memory reason = evil.reentryRevert();
        assertGt(reason.length, 0, "the re-entrant purchase was not refused");

        // Paid once, delivered once.
        assertEq(evil.balanceOf(buyer), RESALE_PRICE, "seller was paid more than once");
        assertEq(evil.balanceOf(reseller), 0, "buyer was charged more than once");
        assertEq(entitlement.ownerOf(tokenId), reseller, "token did not reach the buyer");
    }

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    function test_constructorRejectsZeroAddresses() public {
        vm.expectRevert(EntitlementMarket.ZeroAddress.selector);
        new EntitlementMarket(address(0), address(token));

        vm.expectRevert(EntitlementMarket.ZeroAddress.selector);
        new EntitlementMarket(address(entitlement), address(0));
    }

    // ---------------------------------------------------------------------
    // The market holds no authority
    // ---------------------------------------------------------------------

    /// The whole justification for adding a sixth contract without reopening
    /// the deployed five: it is an ordinary counterparty. If this ever fails,
    /// the market has become part of the trusted set and the argument for
    /// leaving the other contracts untouched no longer holds.
    function test_theMarketHoldsNoRoleAnywhere() public view {
        bytes32[6] memory roles = [
            keccak256("ISSUER_ROLE"),
            keccak256("ORACLE_ROLE"),
            keccak256("COMPLIANCE_ROLE"),
            keccak256("ADMIN_ROLE"),
            keccak256("FACTORY_ROLE"),
            keccak256("REGISTRY_ROLE")
        ];

        for (uint256 i = 0; i < roles.length; i++) {
            assertFalse(entitlement.hasRole(roles[i], address(market)), "market holds an entitlement role");
            assertFalse(escrow.hasRole(roles[i], address(market)), "market holds an escrow role");
            assertFalse(factory.hasRole(roles[i], address(market)), "market holds a factory role");
            assertFalse(registry.hasRole(roles[i], address(market)), "market holds a registry role");
            assertFalse(receipt.hasRole(roles[i], address(market)), "market holds a receipt role");
        }
    }
}
