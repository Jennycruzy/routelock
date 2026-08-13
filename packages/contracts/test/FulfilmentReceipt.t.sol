// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";

import {RouteLockBase} from "./RouteLockBase.t.sol";
import {FulfilmentReceipt} from "../src/FulfilmentReceipt.sol";
import {Roles} from "../src/RouteLockTypes.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @notice A contract that accepts ERC-721 transfers, used to prove the
///         soulbound lock is not merely an EOA-only restriction.
contract ReceiptHolder is IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }
}

/// @notice The issuer's reputation record.
///
/// Two properties carry the design: it cannot move, and it says nothing about
/// the counterparty. Both are asserted here, the second by checking what the
/// stored struct does *not* contain.
contract FulfilmentReceiptTest is RouteLockBase {
    event ReceiptMinted(
        uint256 indexed receiptId, uint256 indexed entitlementTokenId, bytes32 indexed classId, address issuer
    );

    uint64 internal constant ACTIVATED_AT = 1_700_000_000;

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    function test_constructorRejectsZeroAdmin() public {
        vm.expectRevert(FulfilmentReceipt.ZeroAddress.selector);
        new FulfilmentReceipt(address(0));
    }

    function test_metadata() public view {
        assertEq(receipt.name(), "RouteLock Fulfilment Receipt");
        assertEq(receipt.symbol(), "RLFR");
        assertEq(receipt.totalReceipts(), 0);
    }

    function test_supportsBothInterfaces() public view {
        assertTrue(receipt.supportsInterface(type(IERC721).interfaceId));
        assertTrue(receipt.supportsInterface(type(IAccessControl).interfaceId));
        assertTrue(receipt.supportsInterface(type(IERC165).interfaceId));
        assertFalse(receipt.supportsInterface(bytes4(0xdeadbeef)));
    }

    // ---------------------------------------------------------------------
    // Minting — oracle only
    // ---------------------------------------------------------------------

    function test_mintReceiptRecordsFulfilment() public {
        uint256 tokenId = _classWithOneEntitlement();
        _deliver(tokenId);

        vm.expectEmit(true, true, true, true, address(receipt));
        emit ReceiptMinted(1, tokenId, CLASS_ID, issuer);

        vm.prank(oracle);
        uint256 receiptId = receipt.mintReceipt(tokenId, CLASS_ID, issuer, ACTIVATED_AT);

        assertEq(receiptId, 1);
        assertEq(receipt.ownerOf(receiptId), issuer);
        assertEq(receipt.balanceOf(issuer), 1);
        assertEq(receipt.totalReceipts(), 1);
        assertEq(receipt.receiptFor(tokenId), receiptId);

        (
            uint256 entitlementTokenId,
            bytes32 classId,
            address recordedIssuer,
            uint64 activatedAt,
            uint64 deliveredAt
        ) = receipt.receipts(receiptId);
        assertEq(entitlementTokenId, tokenId);
        assertEq(classId, CLASS_ID);
        assertEq(recordedIssuer, issuer);
        assertEq(activatedAt, ACTIVATED_AT);
        assertEq(deliveredAt, uint64(block.timestamp));
    }

    /// @notice Delivery is a carrier-sourced fact, so only the oracle may assert
    ///         it. An issuer minting their own reputation is the failure mode.
    function test_onlyOracleMayMint() public {
        uint256 tokenId = _classWithOneEntitlement();
        _deliver(tokenId);

        address[4] memory outsiders = [issuer, admin, compliance, buyer];
        for (uint256 i = 0; i < outsiders.length; i++) {
            vm.prank(outsiders[i]);
            vm.expectRevert(
                abi.encodeWithSelector(
                    IAccessControl.AccessControlUnauthorizedAccount.selector,
                    outsiders[i],
                    Roles.ORACLE_ROLE
                )
            );
            receipt.mintReceipt(tokenId, CLASS_ID, outsiders[i], ACTIVATED_AT);
        }

        assertEq(receipt.totalReceipts(), 0);
    }

    function test_mintToZeroIssuerReverts() public {
        vm.prank(oracle);
        vm.expectRevert(FulfilmentReceipt.ZeroAddress.selector);
        receipt.mintReceipt(1, CLASS_ID, address(0), ACTIVATED_AT);
    }

    /// @notice One delivery, one receipt. Otherwise a fulfilment record could be
    ///         inflated by minting the same delivery repeatedly.
    function test_secondReceiptForSameEntitlementReverts() public {
        uint256 tokenId = _classWithOneEntitlement();
        _deliver(tokenId);

        vm.startPrank(oracle);
        receipt.mintReceipt(tokenId, CLASS_ID, issuer, ACTIVATED_AT);

        vm.expectRevert(
            abi.encodeWithSelector(FulfilmentReceipt.ReceiptExists.selector, tokenId)
        );
        receipt.mintReceipt(tokenId, CLASS_ID, issuer, ACTIVATED_AT);
        vm.stopPrank();

        assertEq(receipt.totalReceipts(), 1);
    }

    /// @notice The duplicate guard keys on the entitlement, not on the issuer or
    ///         class, so it cannot be sidestepped by varying the other arguments.
    function test_duplicateGuardIgnoresOtherArguments() public {
        uint256 tokenId = _classWithOneEntitlement();
        _deliver(tokenId);

        vm.startPrank(oracle);
        receipt.mintReceipt(tokenId, CLASS_ID, issuer, ACTIVATED_AT);

        vm.expectRevert(
            abi.encodeWithSelector(FulfilmentReceipt.ReceiptExists.selector, tokenId)
        );
        receipt.mintReceipt(tokenId, keccak256("OTHER-CLASS"), supplier, ACTIVATED_AT + 1);
        vm.stopPrank();
    }

    function test_receiptIdsIncrementPerDelivery() public {
        _createClass();
        _fundCollateral(OBLIGATION * MAX_SUPPLY);

        uint256 first = _buy(buyer);
        uint256 second = _buy(buyer);
        _deliver(first);
        _deliver(second);

        vm.startPrank(oracle);
        uint256 firstReceipt = receipt.mintReceipt(first, CLASS_ID, issuer, ACTIVATED_AT);
        uint256 secondReceipt = receipt.mintReceipt(second, CLASS_ID, issuer, ACTIVATED_AT);
        vm.stopPrank();

        assertEq(firstReceipt, 1);
        assertEq(secondReceipt, 2);
        assertEq(receipt.totalReceipts(), 2);
        assertEq(receipt.balanceOf(issuer), 2);
        assertEq(receipt.receiptFor(first), 1);
        assertEq(receipt.receiptFor(second), 2);
    }

    /// @notice Receipt ids start at 1 so that `receiptFor` can use 0 to mean
    ///         "none". A receipt with id 0 would read as an absent one.
    function test_noReceiptReadsAsZero() public {
        uint256 tokenId = _classWithOneEntitlement();
        assertEq(receipt.receiptFor(tokenId), 0);

        _deliver(tokenId);
        vm.prank(oracle);
        uint256 receiptId = receipt.mintReceipt(tokenId, CLASS_ID, issuer, ACTIVATED_AT);
        assertGt(receiptId, 0, "receipt id 0 is indistinguishable from no receipt");
    }

    // ---------------------------------------------------------------------
    // Soulbound
    // ---------------------------------------------------------------------

    /// @notice Reputation that can be sold is not reputation.
    function test_receiptCannotBeTransferred() public {
        uint256 receiptId = _mintedReceipt();

        vm.prank(issuer);
        vm.expectRevert(FulfilmentReceipt.Soulbound.selector);
        receipt.transferFrom(issuer, stranger, receiptId);

        vm.prank(issuer);
        vm.expectRevert(FulfilmentReceipt.Soulbound.selector);
        receipt.safeTransferFrom(issuer, stranger, receiptId);

        assertEq(receipt.ownerOf(receiptId), issuer);
    }

    /// @notice Not an EOA-only restriction: a contract that implements the
    ///         receiver hook is refused on the same terms.
    function test_receiptCannotBeTransferredToAContract() public {
        uint256 receiptId = _mintedReceipt();
        ReceiptHolder holder = new ReceiptHolder();

        vm.prank(issuer);
        vm.expectRevert(FulfilmentReceipt.Soulbound.selector);
        receipt.safeTransferFrom(issuer, address(holder), receiptId);
    }

    /// @notice Approval is allowed to succeed — it grants nothing, because every
    ///         movement is refused at `_update`. Asserted so that an approved
    ///         operator is never mistaken for a usable escape hatch.
    function test_approvedOperatorStillCannotMoveIt() public {
        uint256 receiptId = _mintedReceipt();

        vm.startPrank(issuer);
        receipt.approve(stranger, receiptId);
        receipt.setApprovalForAll(stranger, true);
        vm.stopPrank();

        vm.prank(stranger);
        vm.expectRevert(FulfilmentReceipt.Soulbound.selector);
        receipt.transferFrom(issuer, stranger, receiptId);

        assertEq(receipt.ownerOf(receiptId), issuer);
    }

    /// @notice Admin holds no override. There is no privileged path to move a
    ///         receipt, which is what makes the record worth reading.
    function test_adminCannotMoveAReceipt() public {
        uint256 receiptId = _mintedReceipt();

        vm.prank(admin);
        vm.expectRevert(FulfilmentReceipt.Soulbound.selector);
        receipt.transferFrom(issuer, admin, receiptId);
    }

    /// @notice No burn function exists, so a bad delivery record cannot be
    ///         quietly retired. Documented by asserting the token still stands.
    function test_receiptHasNoBurnPath() public {
        uint256 receiptId = _mintedReceipt();

        vm.prank(issuer);
        vm.expectRevert(FulfilmentReceipt.Soulbound.selector);
        receipt.transferFrom(issuer, address(0xdead), receiptId);

        assertEq(receipt.ownerOf(receiptId), issuer);
        assertEq(receipt.totalReceipts(), 1);
    }

    function test_unmintedReceiptHasNoOwner() public {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 1));
        receipt.ownerOf(1);
    }

    // ---------------------------------------------------------------------
    // Privacy
    // ---------------------------------------------------------------------

    /// @notice The receipt names the issuer and the class, and nothing about the
    ///         counterparty.
    ///
    /// An issuer's track record should be verifiable without publishing their
    /// customer list, so the buyer must not be recoverable from this contract —
    /// not from the struct, not from ownership, not from an event.
    function test_receiptRevealsNothingAboutTheCounterparty() public {
        uint256 tokenId = _classWithOneEntitlement();
        _deliver(tokenId);

        vm.recordLogs();
        vm.prank(oracle);
        uint256 receiptId = receipt.mintReceipt(tokenId, CLASS_ID, issuer, ACTIVATED_AT);

        (, , address recordedIssuer, , ) = receipt.receipts(receiptId);
        assertEq(recordedIssuer, issuer);
        assertEq(receipt.ownerOf(receiptId), issuer, "receipt held by anyone but the issuer");
        assertEq(receipt.balanceOf(buyer), 0, "buyer holds a receipt");

        // And the buyer's address appears in none of the emitted log data.
        bytes32 buyerWord = bytes32(uint256(uint160(buyer)));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            for (uint256 t = 0; t < logs[i].topics.length; t++) {
                assertTrue(logs[i].topics[t] != buyerWord, "buyer leaked in a log topic");
            }
            assertEq(_contains(logs[i].data, buyerWord), false, "buyer leaked in log data");
        }
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _mintedReceipt() internal returns (uint256 receiptId) {
        uint256 tokenId = _classWithOneEntitlement();
        _deliver(tokenId);
        vm.prank(oracle);
        receiptId = receipt.mintReceipt(tokenId, CLASS_ID, issuer, ACTIVATED_AT);
    }

    function _contains(bytes memory haystack, bytes32 needle) internal pure returns (bool) {
        if (haystack.length < 32) return false;
        for (uint256 i = 0; i + 32 <= haystack.length; i++) {
            bytes32 word;
            assembly {
                word := mload(add(add(haystack, 0x20), i))
            }
            if (word == needle) return true;
        }
        return false;
    }
}
